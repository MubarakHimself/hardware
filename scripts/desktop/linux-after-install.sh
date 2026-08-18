#!/bin/sh
set -eu

# Hardware data is owned by the interactive user and is created on first run.
# The package deliberately does not register PostgreSQL or Hardware as a service.
exit 0
