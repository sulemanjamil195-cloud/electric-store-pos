# Generate a Windows .exe from macOS

This project is **source code**, not a precompiled Windows executable.

1. Make a new GitHub repository (private is fine).
2. Upload **the contents of the electric-store-pos directory** to the repository root, including the hidden `.github` folder. Alternatively, commit and push with Git.
3. In GitHub, open **Actions** > **Build Windows Installer** > **Run workflow**. The workflow also runs on pushes to `main`.
4. Once the job succeeds, open its run page and download the artifact `electric-store-pos-windows-installer`.
5. Unzip the artifact to get the Windows `.exe` installer.
6. Copy it by USB onto the shop Windows PC and run the installer.

The shop PC does not need Node.js, npm, or an internet connection to run the installed app.

Important: This is an **unsigned** installer and may show Windows SmartScreen warnings. The app has not been certified for live shop use; back up data, test billing and returns on the target PC, and perform a full acceptance test before relying on it for real transactions.

## Alternative: build on any Windows development computer

Extract the ZIP, open `electric-store-pos`, install Node.js 22, and double-click `BUILD-WINDOWS.bat`. The installer should be in `release` when the build completes.
