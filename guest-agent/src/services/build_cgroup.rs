//! Private child only; never writes parent controls or moves parent/peer PIDs.
use std::{
    fs::{self, File, OpenOptions},
    path::{Path, PathBuf},
};
pub struct BuildCgroup {
    path: PathBuf,
}
impl BuildCgroup {
    pub fn create(parent: &Path) -> Result<Self, String> {
        if !parent.is_absolute() || fs::canonicalize(parent).map_err(|e| e.to_string())? != parent {
            return Err("invalid delegated cgroup parent".into());
        }
        let controllers =
            fs::read_to_string(parent.join("cgroup.subtree_control")).map_err(|e| e.to_string())?;
        if !["cpu", "memory", "pids"]
            .iter()
            .all(|c| controllers.split_whitespace().any(|v| v == *c))
        {
            return Err("delegated cpu memory pids controllers required".into());
        }
        let path = parent.join(format!("pria-build-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).map_err(|e| e.to_string())?;
        let leaf = Self { path };
        for (name, value) in [
            ("memory.max", "1073741824"),
            ("memory.swap.max", "0"),
            ("pids.max", "64"),
            ("cpu.max", "100000 100000"),
        ] {
            fs::write(leaf.path.join(name), value).map_err(|e| e.to_string())?;
        }
        Ok(leaf)
    }
    pub fn procs(&self) -> Result<File, String> {
        OpenOptions::new()
            .write(true)
            .open(self.path.join("cgroup.procs"))
            .map_err(|e| e.to_string())
    }
}
impl Drop for BuildCgroup {
    fn drop(&mut self) {
        let _ = fs::write(self.path.join("cgroup.kill"), "1");
        let _ = fs::remove_dir(&self.path);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disposable_delegated_leaf_limits_only_child() {
        let Some(parent) = std::env::var_os("PRIA_TEST_CGROUP_ROOT") else {
            return;
        };
        let before = fs::read_to_string("/proc/self/cgroup").unwrap();
        let leaf = BuildCgroup::create(Path::new(&parent)).unwrap();
        assert_eq!(
            fs::read_to_string(leaf.path.join("pids.max"))
                .unwrap()
                .trim(),
            "64"
        );
        let file = leaf.procs().unwrap();
        let mut cmd = std::process::Command::new("/usr/bin/cat");
        cmd.arg("/proc/self/cgroup");
        use std::os::{fd::AsRawFd, unix::process::CommandExt};
        unsafe {
            cmd.pre_exec(move || {
                if libc::write(file.as_raw_fd(), b"0".as_ptr().cast(), 1) != 1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let output = cmd.output().unwrap();
        assert!(output.status.success());
        assert!(String::from_utf8(output.stdout)
            .unwrap()
            .contains(leaf.path.file_name().unwrap().to_str().unwrap()));
        assert_eq!(fs::read_to_string("/proc/self/cgroup").unwrap(), before);
        let path = leaf.path.clone();
        drop(leaf);
        assert!(!path.exists());
    }
    #[test]
    fn missing_delegation_fails_without_parent_mutation() {
        let root = std::env::temp_dir().join(format!("delegation-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        assert!(BuildCgroup::create(&root).is_err());
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
        fs::remove_dir(root).unwrap();
    }
}
