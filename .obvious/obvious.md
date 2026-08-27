# sf-website

## Repository status

This repository is currently **empty**. It contains a single file, `README.md`,
whose entire content is the title `# sf-website`. There is no source code, no
dependency manifest (no `package.json`, `go.mod`, `Cargo.toml`,
`pyproject.toml`, `Gemfile`), no `Dockerfile`, no Compose file, and no
`Makefile`.

## What this means for workers

- There is no application here yet, so there is no local dev stack to start,
  no canonical dev command, no ports, and no services. Nothing was snapshotted
  during onboarding because there was nothing running to capture.
- Stack details, run/build/test commands, environment variables, and the
  codebase map are **deliberately omitted** from this file. They will be filled
  in by the next setup run, once real application code has landed in this
  repository.

## Guidance for the next setup run

- Re-run the onboarding/autobuild setup after the first real commit of
  application code.
- Do not infer a framework or scaffold an application on the repository
  owner's behalf — wait for the owner to commit their chosen stack.
- Once code exists, this file should be regenerated with the actual stack,
  commands, ports, env vars, codebase map, local verification steps, and
  sandbox snapshot info.
