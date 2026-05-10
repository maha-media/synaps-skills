/**
 * @file bridge/core/db/index.js
 *
 * Public surface for the MongoDB layer.
 *
 * Re-exports:
 *   getMongoose           – lazy connection singleton factory
 *   disconnect            – close the active connection
 *   isConnected           – boolean connection state
 *   getSynapsWorkspaceModel – model factory bound to a mongoose instance
 *   WorkspaceRepo         – repository class for synaps_workspaces
 */

export { getMongoose, disconnect, isConnected } from './connect.js';
export { getSynapsWorkspaceModel }              from './models/synaps-workspace.js';
export { WorkspaceRepo }                        from './repositories/workspace-repo.js';
