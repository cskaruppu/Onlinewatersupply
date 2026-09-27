#!/usr/bin/env bash
# Removes the NeerNow workloads from an OpenShift project.
#
# Usage:
#   deploy/openshift/undeploy.sh [project]           keeps the database volume and secrets
#   deploy/openshift/undeploy.sh [project] --all     also deletes the database volume and secrets (data is lost)
set -euo pipefail
PROJECT="${1:-neernow}"
ALL="${2:-}"
OC=(oc -n "$PROJECT")

"${OC[@]}" delete deployment,service,route,hpa,pdb,networkpolicy,buildconfig,imagestream,configmap \
  -l app.kubernetes.io/part-of=neernow --ignore-not-found
"${OC[@]}" delete networkpolicy neernow-default-deny --ignore-not-found

if [[ "$ALL" == "--all" ]]; then
  "${OC[@]}" delete pvc neernow-postgres-data --ignore-not-found
  "${OC[@]}" delete secret neernow-secrets neernow-sms --ignore-not-found
  echo "Removed NeerNow and its data from $PROJECT."
else
  echo "Removed NeerNow workloads from $PROJECT. Kept: database volume neernow-postgres-data and secrets."
fi
