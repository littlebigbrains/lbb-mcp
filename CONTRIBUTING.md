# Contributing

Thanks for your interest in the Little Big Brain MCP server!

## How this repository works

This repository is a **one-way export** from the private Little Big Brain
monorepo. Canonical development, code review, and CI happen there; every commit
on `main` here is an allow-listed snapshot that already passed those gates.

Practical consequences:

- **Issues are the best way to contribute.** Bug reports with a minimal
  reproduction (your MCP client, config, and the tool call that misbehaved),
  tool-ergonomics feedback, and documentation fixes are all triaged directly.
- **Pull requests are welcome but are not merged directly.** A maintainer
  ports an accepted patch to the private repository, lands it through private
  CI, and the next export brings it back here — at which point your PR is
  closed with a reference to the canonical commit. You keep authorship credit
  in the release notes.

## Developing

The package is self-contained (Node ≥ 18; `@littlebigbrain/client` resolves
from npm):

```sh
npm ci
npm run typecheck && npm test
npm run pack:check   # build + publint + arethetypeswrong
npx eslint src       # uses eslint.config.js at the repo root
```

`npm start` serves stdio against `LBB_BASE_URL`/`LBB_API_KEY`;
`npm run start:http` serves the streamable-HTTP transport. See the README for
transport and security notes.

## Releases

Maintainers release by pushing a signed `vX.Y.Z` tag, which publishes
`@littlebigbrain/mcp` via npm trusted publishing after CI passes. Each release
depends on a published `@littlebigbrain/client` version.

## Conduct & security

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and [SECURITY.md](SECURITY.md).
Never report security issues in public GitHub issues.
