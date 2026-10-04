{
  description = "TasksNG: a fast, keyboard-friendly task manager for Baikal and other CalDAV servers";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  # CI pushes every build of main to this cache, so installs download the
  # finished package instead of compiling it.
  nixConfig = {
    extra-substituters = [ "https://tasksng.cachix.org" ];
    extra-trusted-public-keys = [
      "tasksng.cachix.org-1:FMPrtDc5KohOuU/tBd1bKryTqsz2igCxhkdO/gNn8Zg="
    ];
  };

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: rec {
        tasksng = pkgs.callPackage ./nix/package.nix { };
        default = tasksng;
      });

      overlays.default = final: _prev: {
        tasksng = final.callPackage ./nix/package.nix { };
      };

      nixosModules.default =
        { lib, pkgs, ... }:
        {
          imports = [ ./nix/module.nix ];
          # Prefer the build CI tested; users can still set programs.tasksng.package.
          programs.tasksng.package = lib.mkDefault self.packages.${pkgs.stdenv.hostPlatform.system}.default;
        };
      nixosModules.tasksng = self.nixosModules.default;

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          # Rust, Node, pkg-config and the GTK/WebKit libraries of the package.
          inputsFrom = [ self.packages.${pkgs.stdenv.hostPlatform.system}.default ];
          packages = with pkgs; [
            cargo-tauri
            clippy
            rustfmt
            rust-analyzer
            php
            phpPackages.composer
          ];
          env.RUST_SRC_PATH = "${pkgs.rustPlatform.rustLibSrc}";
          shellHook = ''
            # tray-icon dlopen()s AppIndicator at runtime, and WebKit needs the
            # GIO TLS module for HTTPS; the package gets both via its wrapper.
            export LD_LIBRARY_PATH="${
              lib.makeLibraryPath [ pkgs.libayatana-appindicator ]
            }''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
            export GIO_EXTRA_MODULES="${pkgs.glib-networking}/lib/gio/modules''${GIO_EXTRA_MODULES:+:$GIO_EXTRA_MODULES}"
          '';
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree);

      checks = forAllSystems (
        pkgs:
        let
          system = pkgs.stdenv.hostPlatform.system;
        in
        {
          package = self.packages.${system}.default;
          # The module evaluates and produces an autostart entry.
          module =
            let
              nixos = lib.nixosSystem {
                inherit system;
                modules = [
                  self.nixosModules.default
                  {
                    programs.tasksng.enable = true;
                    programs.tasksng.autostart = true;
                    boot.isContainer = true;
                    system.stateVersion = "26.05";
                  }
                ];
              };
            in
            let
              pkgsList = nixos.config.environment.systemPackages;
              autostart = lib.findFirst (
                p: lib.hasPrefix "autostart-TasksNG" p.name
              ) (throw "no autostart item") pkgsList;
            in
            assert lib.elem self.packages.${system}.default pkgsList;
            pkgs.runCommand "tasksng-module-check" { } ''
              grep -qx 'Exec=tasksng *--hidden' ${autostart}/etc/xdg/autostart/TasksNG.desktop
              touch $out
            '';
        }
      );
    };
}
