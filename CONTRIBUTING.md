# Contributing

Clone this repository and work from its root. Use Python 3.10 or later and
Node 22 or later. Keep credentials in local environment variables and use
synthetic audio in tests.

## Python

```sh
cd python
python -m venv .venv
. .venv/bin/activate
pip install -e . pytest pytest-asyncio ruff mypy build
pytest -q
ruff check .
ruff format --check .
mypy --strict src
python -m build
```

## TypeScript

```sh
cd typescript
npm ci
npm test
npm run typecheck
npm run lint
npm run build
npm pack --dry-run
```

## Releases

Update package versions and changelogs together and review the packed file lists.
Submit changes for review and merge them into the default branch after CI passes.
Follow the [trusted publisher setup](README.md#publishing-a-package), then dispatch
[Publish package](.github/workflows/publish.yml) for the selected language from
the default branch. The workflow validates the package before publishing its
artifact through the protected npm or pypi environment.
