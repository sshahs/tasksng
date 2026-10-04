# NixOS module: `programs.tasksng`. Works from the flake
# (nixosModules.default) and without flakes:
#   imports = [ "${tasksng-src}/nix/module.nix" ];
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.tasksng;
in
{
  options.programs.tasksng = {
    enable = lib.mkEnableOption "TasksNG, a task manager for Baikal and other CalDAV servers";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "pkgs.callPackage ./nix/package.nix { }";
      description = "The TasksNG package to install.";
    };

    autostart = lib.mkEnableOption ''
      starting TasksNG in the background when anyone logs in to a graphical
      session (an entry in /etc/xdg/autostart; each user can still turn it
      off in TasksNG's settings)
    '';

    keyring = lib.mkEnableOption ''
      GNOME Keyring, a Secret Service provider, so TasksNG can keep your
      password in a keyring that is unlocked at login. GNOME and KDE Plasma
      already provide one; this is for window managers such as Sway, Hyprland
      or i3. Without any provider the password is kept in a file only you can
      read'';
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [
      cfg.package
    ]
    ++ lib.optional cfg.autostart (
      pkgs.makeAutostartItem {
        name = "TasksNG"; # share/applications/TasksNG.desktop (the Tauri productName)
        package = cfg.package;
        appendExtraArgs = [ "--hidden" ];
      }
    );

    services.gnome.gnome-keyring.enable = lib.mkIf cfg.keyring true;
  };
}
