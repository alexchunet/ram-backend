'use strict';
import Joi from 'joi';
import Promise from 'bluebird';
import cp from 'child_process';

import config from '../config';
import db from '../db/';
import { removeFile } from '../s3/utils';
import { ScenarioNotFoundError, DataConflictError, getBoomResponseForError } from '../utils/errors';
import { getProject } from './projects--get';
import Operation from '../utils/operation';
import ServiceRunner from '../utils/service-runner';
import { closeDatabase } from '../services/rra-osm-p2p';
import { createRoadNetworkVT } from '../utils/vector-tiles';

// Stores running processes to be able to kill them.
let runningProcesses = {};

module.exports = [
  {
    path: '/projects/{projId}/scenarios/{scId}/generate',
    method: 'POST',
    config: {
      validate: {
        params: {
          projId: Joi.number(),
          scId: Joi.number()
        }
      }
    },
    handler: async (request, reply) => {
      try {
        const { projId, scId } = request.params;
        const opCheck = new Operation(db);

        try {
          // Try to load the operation to see if it exists.
          await opCheck.loadByData('generate-analysis', projId, scId);
        } catch (err) {
          // In this case if the operation doesn't exist is not a problem.
          if (!err.message.match(/not exist/)) throw err;
        }

        if (opCheck.isStarted()) {
          throw new DataConflictError('Result generation already running');
        }

        // Valid project ?
        // Projects already setup ?
        const project = await getProject(projId);
        if (project.status !== 'active') {
          throw new DataConflictError('Project setup not completed');
        }

        const scenario = await db.select('*')
          .from('scenarios')
          .where('id', scId)
          .where('project_id', projId)
          .first();
        if (!scenario) throw new ScenarioNotFoundError();

        // Admin areas selected ?
        const aaSetting = await db('scenarios_settings')
          .select('value')
          .where('key', 'admin_areas')
          .where('scenario_id', scId)
          .first();
        if (aaSetting.value === '[]') {
          throw new DataConflictError('No admin areas selected');
        }

        // Good to go.
        // Delete all existing results. (s3 and database)
        const files = await db('scenarios_files')
          .select('*')
          .where('scenario_id', scId)
          .where('project_id', projId)
          .whereIn('type', ['results-csv', 'results-json', 'results-geojson']);

        const rmFilesTasks = files.map(f => removeFile(f.path));
        const ids = files.map(f => f.id);
        await Promise.all([
          ...rmFilesTasks,
          db('scenarios_files')
            .whereIn('id', ids)
            .del(),
          db('results')
            .where('project_id', projId)
            .where('scenario_id', scId)
            .del()
        ]);

        // Generate the results.
        // Will start an operation and handle error with it.
        // The promise resolves in the background.
        // This is intentional.
        generateResults(projId, scId);

        return reply({statusCode: 200, message: 'Result generation started'});
      } catch (error) {
        return reply(getBoomResponseForError(error));
      }
    }
  },
  {
    path: '/projects/{projId}/scenarios/{scId}/generate',
    method: 'DELETE',
    config: {
      validate: {
        params: {
          projId: Joi.number(),
          scId: Joi.number()
        }
      }
    },
    handler: async (request, reply) => {
      try {
        const { projId, scId } = request.params;
        const op = new Operation(db);

        try {
          // Try to load the operation to see if it exists.
          await op.loadByData('generate-analysis', projId, scId);
        } catch (err) {
          // Can's stop the operation if it doesn't exist.
          if (err.message.match(/not exist/)) {
            throw new DataConflictError('Result generation not running');
          }
        }

        if (!op.isStarted()) {
          throw new DataConflictError('Result generation not running');
        }

        // Send kill signal to generation process.
        await killAnalysisProcess(projId, scId);

        // Abort operation.
        await op.finish('error', {error: 'Operation aborted'});

        return reply({statusCode: 200, message: 'Result generation aborted'});
      } catch (error) {
        return reply(getBoomResponseForError(error));
      }
    }
  }
];

function setImmediatePromise (cb) {
  return new Promise((resolve, reject) => {
    setImmediate(() => {
      cb().then(resolve).catch(reject);
    });
  });
}

async function generateResults (projId, scId) {
  // In test mode we don't want to start the generation.
  // It will be tested in the appropriate place.
  if (process.env.DS_ENV === 'test') { return; }

  const identifier = `p${projId} s${scId}`;
  const op = new Operation(db);

  try {
    // Start the operation.
    await op.start('generate-analysis', projId, scId);
    await op.log('start', {message: 'Analysis generation started'});
    const opId = op.getId();

    if (!runningProcesses[identifier]) runningProcesses[identifier] = {};

    // Check if we need to export the road network.
    let [genAt, activeEditing, rnUpdatedAt] = await db('scenarios_settings')
      .select('value')
      .where('scenario_id', scId)
      .whereIn('key', ['res_gen_at', 'rn_active_editing', 'rn_updated_at'])
      .orderBy('key')
      .then(res => res.map(r => r.value));

    let needExport = false;
    if (activeEditing === 'true') {
      genAt = genAt === 0 ? genAt : (new Date(genAt)).getTime();
      rnUpdatedAt = rnUpdatedAt === 0 ? rnUpdatedAt : (new Date(rnUpdatedAt)).getTime();
      needExport = rnUpdatedAt > genAt;

      if (!needExport) {
        console.log(identifier, 'Road network was not modified');
      }
    } else {
      console.log(identifier, 'Road network editing not enabled');
    }

    await setImmediatePromise(async () => {
      if (needExport) {
        // Close the database on this thread process before exporting the
        // road network on a new thread process. (using a service runner)
        await closeDatabase(projId, scId);
        await updateRN(projId, scId, opId);
        await generateTiles(projId, scId, op);
      }

      await spawnAnalysisProcess(projId, scId, opId);
    });

  // Catching errors.
  } catch (error) {
    // The operation may not have finished if the error took place outside
    // the promise, or if the error was due to a wrong db connection.
    if (!op.isCompleted()) {
      await op.finish('error', {error: error.message || error});
    }
    console.log(identifier, 'generateResults error was handled:', error);
  }
}

function updateRN (projId, scId, opId) {
  return new Promise((resolve, reject) => {
    let identifier = `p${projId} s${scId}`;
    console.log(identifier, 'updateRN');
    let service = new ServiceRunner('export-road-network', {projId, scId, opId});

    runningProcesses[identifier].updateRN = service;

    service.on('complete', err => {
      runningProcesses[identifier].updateRN = null;
      console.log(identifier, 'updateRN complete');

      if (err) {
        console.log(identifier, 'updateRN ended in error and was captured');
        reject(err);
      } else {
        resolve();
      }
    })
    .start();
  });
}

async function generateTiles (projId, scId, op) {
  const identifier = `p${projId} s${scId}`;
  console.log(identifier, 'generating vector tiles');

  const rnFile = await db('scenarios_files')
    .select('*')
    .where('scenario_id', scId)
    .where('type', 'road-network')
    .first();

  // createRoadNetworkVT returns an objects with a promise and a kill switch
  const service = createRoadNetworkVT(projId, scId, op, rnFile.path);
  runningProcesses[identifier].genVT = service;

  // Wait for the service to finish.
  await service.promise;

  // Cleanup.
  runningProcesses[identifier].genVT = null;
}

async function spawnAnalysisProcess (projId, scId, opId) {
  // Update image before starting.
  function pullImage () {
    return new Promise((resolve, reject) => {
      const cmd = config.analysisProcess.service;
      const args = [ 'pull', config.analysisProcess.container ];
      const env = {
        HYPER_ACCESS: config.analysisProcess.hyperAccess,
        HYPER_SECRET: config.analysisProcess.hyperSecret
      };

      // Make sure the latest image (dev / stable) is used.
      let pullImage = cp.spawn(cmd, args, { env: Object.assign({}, process.env, env) });

      let error;
      pullImage.stderr.on('data', (data) => {
        error = data.toString();
        console.log(`[ANALYSIS P${projId} S${scId}][ERROR]`, error);
      });

      pullImage.on('close', code => {
        if (code !== 0) {
          console.log(`[ANALYSIS P${projId} S${scId}][ERROR]`, 'Pull image error', error);
          console.log(`[ANALYSIS P${projId} S${scId}][ERROR]`, 'Continuing...');
        }
        return resolve();
      });
    });
  }

  // Run the analysis.
  function runProcess () {
    return new Promise((resolve, reject) => {
      console.log(`[ANALYSIS P${projId} S${scId}]`, 'spawnAnalysisProcess');
      const containerName = `${config.instanceId}-analysisp${projId}s${scId}`;
      const service = config.analysisProcess.service;
      let env = {};

      // Each Project/Scenario combination can only have one analysis process
      // running.
      let args = [
        'run',
        '--name', containerName,
        '--rm',
        '-e', `DB_URI=${config.analysisProcess.db}`,
        '-e', `PROJECT_ID=${projId}`,
        '-e', `SCENARIO_ID=${scId}`,
        '-e', `OPERATION_ID=${opId}`,
        '-e', `STORAGE_HOST=${config.analysisProcess.storageHost}`,
        '-e', `STORAGE_PORT=${config.analysisProcess.storagePort}`,
        '-e', `STORAGE_ENGINE=${config.storage.engine}`,
        '-e', `STORAGE_ACCESS_KEY=${config.storage.accessKey}`,
        '-e', `STORAGE_SECRET_KEY=${config.storage.secretKey}`,
        '-e', `STORAGE_BUCKET=${config.storage.bucket}`,
        '-e', `STORAGE_REGION=${config.storage.region}`,
        '-e', 'CONVERSION_DIR=/conversion'
      ];

      switch (service) {
        case 'docker':
          args.push(
            '--network', 'ram'
          );
          break;
        case 'hyper':
          env = {
            HYPER_ACCESS: config.analysisProcess.hyperAccess,
            HYPER_SECRET: config.analysisProcess.hyperSecret
          };
          if (config.analysisProcess.hyperSize) {
            args.push(
              `--size=${config.analysisProcess.hyperSize}`
            );
          }
          break;
        default:
          return Promise.reject(new Error(`${service} is not a valid option. The analysis should be run on 'docker' or 'hyper'. Check your config file or env variables.`));
      }

      // Append the name of the image last
      args.push(config.analysisProcess.container);

      let proc = cp.spawn(service, args, { env: Object.assign({}, process.env, env) });
      let error;

      proc.stdout.on('data', (data) => {
        console.log(`[ANALYSIS P${projId} S${scId}]`, data.toString());
      });

      proc.stderr.on('data', (data) => {
        error = data.toString();
        console.log(`[ANALYSIS P${projId} S${scId}][ERROR]`, error);
      });

      proc.on('close', (code) => {
        let identifier = `p${projId} s${scId}`;
        console.log(`[ANALYSIS P${projId} S${scId}][EXIT]`, code.toString());
        delete runningProcesses[identifier];

        if (code !== 0) {
          return reject(new Error(error));
        }

        return resolve();
      });
    });
  }

  await pullImage();
  await runProcess();
}

function killAnalysisProcess (projId, scId) {
  if (process.env.DS_ENV === 'test') { return Promise.resolve(); }

  return new Promise((resolve, reject) => {
    const identifier = `p${projId} s${scId}`;
    // Since the processes run sequentially check by order which we need
    // to kill.
    if (runningProcesses[identifier].updateRN) {
      runningProcesses[identifier].updateRN.kill();
      runningProcesses[identifier].updateRN = null;
      return resolve();
    }
    if (runningProcesses[identifier].genVT) {
      runningProcesses[identifier].genVT.kill();
      runningProcesses[identifier].genVT = null;
      return resolve();
    }

    const service = config.analysisProcess.service;
    const containerName = `${config.instanceId}-analysisp${projId}s${scId}`;
    let env = {};

    switch (service) {
      case 'hyper':
        env = {
          HYPER_ACCESS: config.analysisProcess.hyperAccess,
          HYPER_SECRET: config.analysisProcess.hyperSecret
        };
        break;
      case 'docker':
        break;
      default:
        return reject(new Error(`${service} is not a valid option. The analysis should be run on 'docker' or 'hyper'. Check your config file or env variables.`));
    }

    cp.exec(`${service} rm -f ${containerName}`, { env: Object.assign({}, process.env, env) }, (errStop) => {
      if (errStop) {
        console.log(`[ANALYSIS P${projId} S${scId}][ABORT] stop`, errStop);
      }
    });

    // Assume the exec works and resolve immediately. The closing of the
    // connection is handled by the process spawn in spawnAnalysisProcess();
    return resolve();
  });
}
