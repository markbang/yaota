# Mobile CI Integration

The existing `markbang/cohub-mobile` workflow still uses its old publisher and update endpoint. Its original secret and variables have not been changed. Do not redirect that endpoint just because the new Worker is deployed: installed native apps still use it, and the new service has not imported old OTA history.

## Prerequisites

1. Create `cohub-mobile` in the Yaota dashboard, retaining its exact ID.
2. Import the signing private key and matching `certs/ota-certificate.crt` in Dashboard Settings or through the [credential API](credentials.md). The environment-backed `scripts/configure-signing.ts` is also supported. The public certificate alone is insufficient.
3. Create a publishing token in Settings and add it as a separate GitHub Actions secret `YAOTA_OTA_API_KEY`. Existing installations may use the legacy `.secrets/publisher.json` value. Keep the old service's `OTA_API_KEY` until cutover is explicitly approved.
4. Reuse the exact export directory from the Android/iOS build job. Resolve the native runtime and source fingerprint separately; never replace both with a guessed app version.

## Canary Publish

This is a template for the Android job after the existing Expo export, not a workflow already applied to cohub-mobile. Resolve `native-runtime` and `source-fingerprint` from that job's existing metadata. Export the public Expo config with the same environment used during that export. Use a pinned reviewed Yaota commit for `YAOTA_COMMIT`.

```yaml
- name: Publish staged Yaota canary
  uses: markbang/yaota/.github/actions/publish-ota@YAOTA_COMMIT
  with:
    server: https://ota.example.com
    api-key: ${{ secrets.YAOTA_OTA_API_KEY }}
    app-id: cohub-mobile
    export-dir: ${{ runner.temp }}/cohub-ota-export
    config: ${{ runner.temp }}/expo-public-config.json
    platform: android
    runtime: ${{ steps.native-runtime.outputs.value }}
    fingerprint: ${{ steps.source-fingerprint.outputs.value }}
    channel: yaota-canary
    staged: 'true'
    delta-bases: '3'
```

Use the same action with `platform: ios` in the iOS job. A staged publication cannot be served by `/manifest`; explicitly promote it for a test-device channel when ready. Automatic patches run in this action/TypeScript publisher, not in the old upload-only CLI or dashboard upload.

## Device Acceptance

Run on Android and iOS builds trusting the production certificate and using the new endpoint with a test channel. Preserve runtime/fingerprint compatibility.

- Publish A, install it, restart, and record `Updates.updateId`.
- Publish a small compatible B. Confirm SDK 57 opts into BSDIFF40, receives 226 when a patch is smaller, reconstructs the manifest hash and launches B.
- Test a client without a registered base: full download must launch B too.
- Roll back B. The returned update must have a new UUID/timestamp, old A bytes, and launch successfully.
- Send the embedded rollback directive and verify the embedded app starts.
- Confirm 10% rollout is stable over repeated checks and expands without dropping already-selected clients.
- Use the same channel/runtime in another app and confirm neither updates nor rollback directives cross apps.

Only then choose either a new native release pointing to the new hostname or a coordinated migration of the existing update hostname, including history/fingerprint baselines. This repository cannot verify native launch or manufacture an existing client's signing key.
