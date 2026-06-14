//! Typed identifiers used across the guest-agent API surface.
//!
//! Keeping IDs as newtypes (spec §12 "typed IDs over raw strings") prevents
//! accidentally swapping an `account_id` for a `vm_id` at a call site and makes
//! the HMAC binding checks explicit.

use std::fmt;

use serde::{Deserialize, Serialize};

macro_rules! typed_id {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl From<String> for $name {
            fn from(s: String) -> Self {
                $name(s)
            }
        }

        impl From<&str> for $name {
            fn from(s: &str) -> Self {
                $name(s.to_string())
            }
        }
    };
}

typed_id!(
    /// Pria account identifier (`acct_...`).
    AccountId
);
typed_id!(
    /// Account VM identifier (`vm_...`).
    VmId
);
typed_id!(
    /// Instance identifier (`inst_...`).
    InstanceId
);
typed_id!(
    /// Pria user identifier (`user_...`).
    UserId
);
typed_id!(
    /// Session identifier (`sess_...`).
    SessionId
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newtype_roundtrips_through_json() {
        let id = AccountId::from("acct_123");
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, "\"acct_123\"");
        let back: AccountId = serde_json::from_str(&json).unwrap();
        assert_eq!(back, id);
    }

    #[test]
    fn display_is_inner_string() {
        assert_eq!(VmId::from("vm_9").to_string(), "vm_9");
    }
}
