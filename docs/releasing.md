# Publishing

## Current status

- Package: `jev-auto-router`
- Version: `0.1.0`
- Git tag: `v0.1.0`
- npm registry: **not published yet** (`npm view jev-auto-router` returns 404)
- Until the first publish, install from a local clone/source build.

## One-time npm setup

1. Confirm you are logged in as the package owner:

   ```sh
   npm whoami
   ```

2. Create an npm automation token with publish rights for `jev-auto-router`
   (or use a granular token with the package scope). Add it to GitHub as the
   repository secret `NPM_TOKEN`.
3. Do not commit the token or write it into `~/.npmrc` in this repository.

## Manual publish

```sh
npm login
npm ci
npm test
npm run typecheck
npm pack --dry-run
npm publish --tag latest
```

If npm asks for a one-time password, pass it interactively or use
`--otp=<code>`. Do not put the OTP in shell history.

Verify:

```sh
npm view jev-auto-router version dist-tags
npm install -g jev-auto-router@latest
jev-codex --version
```

## Version and tag

Use semver. Before a release:

```sh
npm version patch   # or minor / major
git push --follow-tags
```

The `Release` workflow publishes when a `v*` tag is pushed. It can also be
started manually from GitHub Actions, using the version currently checked out
on the selected branch.

The existing `v0.1.0` tag predates the workflow. Publish that version manually,
or move/recreate the tag only when you are ready to run the release workflow.

## Rollback

- npm versions are immutable; publish a new patch version instead of deleting.
- If a release is broken, deprecate it:

  ```sh
  npm deprecate jev-auto-router@0.1.0 "Use 0.1.1 or newer"
  ```

- Keep the GitHub release notes and npm dist-tag aligned.
