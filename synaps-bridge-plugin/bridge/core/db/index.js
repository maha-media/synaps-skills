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
 *   makeHeartbeatModel       – model factory for synaps_heartbeat
 *   HeartbeatRepo            – repository class for synaps_heartbeat
 *   makeHeartbeatRepo        – convenience factory: makeHeartbeatRepo(mongoose, opts?)
 */

export { getMongoose, disconnect, isConnected } from './connect.js';
export { getSynapsWorkspaceModel }              from './models/synaps-workspace.js';
export { getSynapsUserModel }                   from './models/synaps-user.js';
export { getSynapsChannelIdentityModel }        from './models/synaps-channel-identity.js';
export { getSynapsLinkCodeModel }               from './models/synaps-link-code.js';
export { makeHeartbeatModel }                   from './models/synaps-heartbeat.js';
export { WorkspaceRepo }                        from './repositories/workspace-repo.js';
export { UserRepo }                             from './repositories/user-repo.js';
export { ChannelIdentityRepo }                  from './repositories/channel-identity-repo.js';
export { LinkCodeRepo }                         from './repositories/link-code-repo.js';
export { HeartbeatRepo }                        from './repositories/heartbeat-repo.js';

import { makeHeartbeatModel as _makeHeartbeatModel } from './models/synaps-heartbeat.js';
import { HeartbeatRepo as _HeartbeatRepo }           from './repositories/heartbeat-repo.js';

/**
 * Convenience factory — builds a HeartbeatRepo wired to the Heartbeat model
 * for the given mongoose instance.
 *
 * @param {import('mongoose').Mongoose} mongooseInstance
 * @param {object}     [opts]       - Options forwarded to HeartbeatRepo.
 * @param {() => Date} [opts.now]   - Injectable clock (useful in tests).
 * @returns {HeartbeatRepo}
 */
export function makeHeartbeatRepo(mongooseInstance, opts = {}) {
  const Heartbeat = _makeHeartbeatModel(mongooseInstance);
  return new _HeartbeatRepo({ Heartbeat, ...opts });
}
