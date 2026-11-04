# Security

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Report them privately using GitHub's [private vulnerability reporting](../../security/advisories/new) for this repository. Include:

- the type of issue (for example, authentication bypass or information disclosure);
- the affected file paths or endpoints;
- steps to reproduce, and a proof of concept if available;
- the potential impact.

You will receive an acknowledgment, and coordinated disclosure will be agreed before any public discussion.

## Secrets

This repository never contains credentials, tenant identifiers or environment URLs. All secrets are stored in Azure Key Vault and supplied at deployment time. If you find a secret in this repository or its history, report it privately as described above.
