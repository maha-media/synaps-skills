/**
 * @file bridge/core/db/index.js
 *
 * Public surface for the MongoDB layer.
 *
 * Re-exports:
 *   getMongoose              – lazy connection singleton factory
 *   disconnect               – close the active connection
 *   isConnected              – boolean connection state
 *   getSynapsWorkspaceModel  – model factory bound to a mongoose instance
 *   WorkspaceRepo            – repository class for synaps_workspaces
 *   UserRepo                 – repository class for synaps_users
 *   ChannelIdentityRepo      – repository class for synaps_channel_identities
 *   LinkCodeRepo             – repository class for synaps_link_codes
 */

export { getMongoose, disconnect, isConnected } from './connect.js';
export { getSynapsWorkspaceModel }              from './models/synaps-workspace.js';
export { WorkspaceRepo }                        from './repositories/workspace-repo.js';
export { UserRepo }                             from './repositories/user-repo.js';
export { ChannelIdentityRepo }                  from './repositories/channel-identity-repo.js';
export { LinkCodeRepo }                         from './repositories/link-code-repo.js';
