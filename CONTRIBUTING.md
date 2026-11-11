# Contributing

## Commits and pull requests

- Branch names describe the change (`fix/…`, `feat/…`, `chore/…`), never a tool.
- Keep pull requests short:
  - what changed, in a line or two
  - the bug, if it fixes one
  - the files edited or added
  - the reason, if it isn't obvious

## Documentation

- User documentation lives in the wiki, [ashipaek0/epilykos-wiki](https://github.com/ashipaek0/epilykos-wiki),
  published at <https://ashipaek0.github.io/epilykos-wiki/>. The README keeps only the quick start, the
  compose file and links.
- When a change alters what users see or do (settings, sources, cards, install steps), update the
  matching wiki page in the same pass, and the in-app Help in `public/settings.html` if it covers it.
- After changing device profiles, regenerate the wiki's supported hardware page there with
  `npm run gen:hardware -- <path to this repo>`.
