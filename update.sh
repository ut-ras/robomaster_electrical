#!/bin/bash
# update.sh
# This script updates all submodules recursively to the latest commits on their tracked branches.

# Exit immediately if a command exits with a non-zero status.
set -e

echo "Setting all project submodules to their latest commit..." 
git submodule foreach 'git reset --hard && git clean -fd'
git submodule update --remote --recursive
echo "Projects updated successfully."
