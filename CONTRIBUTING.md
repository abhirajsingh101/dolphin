# Contributing to Dolphin

Thank you for helping. Bug reports, fixes and small improvements are all
welcome.

## Reporting a bug

In Dolphin, choose Help, then Report an Issue. It opens a GitHub issue with
the version, your system and the helper's recent log lines filled in, with
home folders, host names, addresses and tokens removed. Read it before you
submit.

For a security problem, follow [SECURITY.md](SECURITY.md) instead.

## Suggesting a feature

Open a [feature request](https://github.com/abhirajsingh101/dolphin/issues/new?template=feature_request.yml).
Describe the problem you have before the feature you want; there may be a
simpler way to solve it.

## Changing the code

[docs/development.md](docs/development.md) covers setting up, running,
testing and packaging. Before you open a pull request:

- Keep it to one change, and say what it fixes and how you checked it.
- Run the three test suites from docs/development.md. A change to the
  workspace, the helper or the app should also come with a test that fails
  without it.
- Never let a test touch your real machine: Electron tests use a scratch
  `HOME` or `DOLPHIN_HOME`, and anything that opens a terminal uses a scratch
  `TMUX_TMPDIR` with `TMUX` and `TMUX_PANE` removed.
- For a visible change, attach a screenshot in light and dark.

This repository is exported from Dolphin's development repository, so a
merged pull request comes back in the next export with your authorship kept
in the commit message.

## License

By contributing, you agree that your contribution is licensed under the MIT
License in [LICENSE](LICENSE).
