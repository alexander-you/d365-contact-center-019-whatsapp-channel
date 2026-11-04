# Contributing

Thank you for your interest in this project.

## How to contribute

1. Open an issue that describes the change or problem.
2. Fork the repository and create a feature branch.
3. Keep changes focused and include tests for the mapping logic (`src/adapter/test`).
4. Run `npm ci && npm test` in `src/adapter`.
5. Open a pull request that references the issue.

## Guidelines

- Never commit secrets, tenant ids, environment URLs, phone numbers or customer data. Use the `*.example.json` files and placeholders.
- Keep Bicep and PowerShell scripts idempotent.
- Document behavior changes in `docs/`.
- Use synthetic test data only.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
