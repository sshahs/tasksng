//! Command-line flags. A second `tasksng …` hands its flags to the running
//! instance (single-instance plugin), so e.g. a desktop shortcut running
//! `tasksng --quick-add` opens quick add, which is how global shortcuts work
//! on Wayland.

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Cli {
    pub hidden: bool,
    pub quick_add: bool,
    pub show: bool,
    pub sync: bool,
    pub quit: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Early {
    Version,
    Help,
}

pub const HELP: &str = "\
Usage: tasksng [OPTION]

  --hidden       start in the background (used when starting at login)
  --quick-add    open the quick add box (bind this to a keyboard shortcut)
  --show         show the main window
  --sync         sync now
  --quit         quit the running TasksNG
  -V, --version  print the version and exit
  -h, --help     print this help and exit
";

impl Cli {
    /// Parses arguments (the first one is the program). Unknown arguments,
    /// e.g. from a file manager, are ignored.
    pub fn parse<I, S>(args: I) -> Result<Cli, Early>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut cli = Cli::default();
        for a in args.into_iter().skip(1) {
            match a.as_ref() {
                "-V" | "--version" => return Err(Early::Version),
                "-h" | "--help" => return Err(Early::Help),
                "--hidden" => cli.hidden = true,
                "--quick-add" => cli.quick_add = true,
                "--show" => cli.show = true,
                "--sync" => cli.sync = true,
                "--quit" => cli.quit = true,
                _ => {}
            }
        }
        Ok(cli)
    }

    pub fn from_env() -> Result<Cli, Early> {
        Cli::parse(std::env::args_os().map(|a| a.to_string_lossy().into_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_flags() {
        assert_eq!(
            Cli::parse(["/nix/store/x/bin/tasksng", "--quick-add", "--hidden"]),
            Ok(Cli { quick_add: true, hidden: true, ..Default::default() })
        );
        assert_eq!(Cli::parse(["tasksng", "--hidden", "--version"]), Err(Early::Version));
        assert_eq!(Cli::parse(["tasksng", "-h"]), Err(Early::Help));
        assert_eq!(Cli::parse(["tasksng", "some-file.ics"]), Ok(Cli::default()));
    }
}
