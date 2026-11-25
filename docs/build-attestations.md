# Build attestations

Every image the build workflows push (`irunmole/epilykos`, the `latest` and `dev` channels) is signed with a
**build-provenance attestation**: a statement, signed by GitHub with a short-lived key issued to that workflow run,
that this exact image digest was built from this repository by this workflow. There is no signing key to store or
rotate, and the statement is recorded in a public transparency log.

## Check an image yourself

With the [GitHub CLI](https://cli.github.com/):

```sh
gh attestation verify oci://docker.io/irunmole/epilykos@sha256:<digest> --repo ashipaek0/Epilykos
```

It succeeds only if the digest was built by a workflow in `ashipaek0/Epilykos`. To also pin which workflow, add
`--signer-workflow ashipaek0/Epilykos/.github/workflows/docker-build.yml` (the `latest` channel) or
`.../docker-build-dev.yml` (the `dev` channel).

## Where the reference is

- **The digest record** (`digest-epilykos.json`, handed to EpilykosOS in the `app-image-published` dispatch) has an
  `attestation` object when the build made one: `id`, `url`, `repository`, `signer_workflow` (the workflow run's
  `workflow_ref`) and `subject` (`image@digest`).
- **The update feed** (`latest.json` / `dev.json` on the `update-feed` branch) copies it into the `attestation` field
  of each entry. The app passes it through unchanged in its saved update status.

A build whose attestation could not be made still pushes and is recorded, **without** an `attestation` field: a
signing outage must not stop a release. Anything that installs an image must therefore treat a record or feed entry
without one as unverified and refuse it.

## What checks it

The app only relays the digest to its host, so the check belongs where the install happens: EpilykosOS, before it pins
a digest in its manifest or applies an update, should run the verification above (or the equivalent with the Sigstore
libraries) against `attestation.repository` and require `attestation.signer_workflow` to be a workflow of this
repository. Until it does, the attestation is published and checkable by hand but not enforced.
