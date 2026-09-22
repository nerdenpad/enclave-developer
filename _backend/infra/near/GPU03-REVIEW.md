# GLM gpu03 development candidate review — 2026-09-19

`policy.gpu03.candidate.json` remains **expired** as the original review artifact.
After explicit review, its entire profile was approved for bounded development
and added to `policy.glm-2026-09-19.json`, version
`development-glm-2026-09-19.2`, alongside the independent gpu04 profile.
Hardware verification passed for this observed VM:
Intel TDX model/manager quotes `UpToDate` without advisories, eight NVIDIA GH100
GPU results verified with ES384 signatures, and matching nonce/TLS/manager
bindings. No inference was run for this review.

## Evidence and official files

The authenticated history has 115 actions: 78 `compose_up`, 30 `compose_down`,
five `compose_stage`, one manager start, and one `docker_clean`. Every one of the
58 distinct `(commit, file, file_sha256)` claims was downloaded from
`raw.githubusercontent.com/nearai/cvm-compose-files/<immutable-commit>/<file>`;
all 58 SHA-256 values matched exactly. An additional five files cover teardown
references and gpu04 comparison, for 63 checked source files total.

The complete history/base manifest is in
`provenance/glm-gpu03-2026-09-19.json`. The complete URL/hash comparison is in
`provenance/glm-gpu03-source-hashes.json`. These contain public deployment
configuration, including environment *placeholders*, not secret values.

## Differences from the reviewed gpu04 profile

| Field | gpu04 profile | gpu03 candidate |
|---|---|---|
| Base compose | `INSTANCE_LABEL=gpu04` | `INSTANCE_LABEL=gpu03`; this is the only decoded manifest difference |
| App compose SHA-256 | `c82b1a2eaf6996154a5f39ae621643f034b082d5e51edd3d2ba6009273881d86` | `55db164f4f8c6a837c2217c601c21bba4758f908536a6cd5b2978550205a9179` |
| TDX measurements | Existing profile | MRCONFIGID and RTMR3 differ; all other pinned measurement fields match |
| Runtime history | 59 actions | 115 actions, including earlier benchmark variants and cleanup |
| Manager image | `nearaidev/compose-manager@sha256:6e035c8fb99c1d31f41760d25af178683a658cca4afd73cd0d366fbb5bf884be` | Same reported startup image |
| Serving variant | SGLang TP4 replicas | HiCache variant: second replica offloads KV cache into guest host RAM |
| HF model revision | `84c6a6aa9497188e15a635ba793b0f95a79b1033` | Same |
| Chat-template revision | `3f1971b7b5f7a528c9c4ef6212c8785298a8c24a` | Same |
| Proxy and nginx images | Pinned below | Same |
| Signing address | `0x3b753b4406613c5e70ae640508632b600424fa0c` | Same; signing identity alone does not identify one VM |
| TLS SPKI | `375ce9c3129cc9fdbb230083f70e10330720857b56c2efd8d62425e38a11de43` | `aaf70a60f0e55a3cfcdb3d58142a25e34b620c85e2d796e91edfd9086ca09b27` |

Keys above are observations for review, not permanent policy pins. Fresh TLS
attestation is required on every inference.

The last explicit model-replica start actions refer to
[HiCache at commit 065340e](https://github.com/nearai/cvm-compose-files/blob/065340e05635b885dfb238fe9f3601ad351d68a8/prod/GLM-5.3-Flash-SGL-TP4-HiCache.yaml),
SHA-256 `e207fecf556ac8790723c3edfc40bfd844cd9c491d54979622350e9f3d3b38ea`:

* Replica r1: `docker.io/nearaidev/sglang@sha256:a7b7136abcf5e07522289d96e96fec9b42a1a30f9dfda57e957f142680d2d67b`.
* Replica r2: `docker.io/nearaidev/sglang@sha256:01f44c790d43b3eae136f5f3bc930599947bd37fcea081d2dbd3271ff4fc3f8a`.
* Both retain fixed model/template revisions, TP4/EP4, BF16 KV, EAGLE speculation,
  strict thinking, offline HF/Transformers and disabled telemetry. Request
  logging is not enabled; `--log-requests-level 0` and labels identify disabled
  request logging. Stdout/stderr still goes to Docker/OTel, so an application
  defect that logs sensitive data is outside this configuration review.
* r2 adds `--enable-hierarchical-cache`, `write_through`, direct I/O, and
  `page_first_direct`. Host-memory settings use a default 80% RAM budget and
  pooled transfers. This enlarges the sensitive KV-cache residency into the
  TDX guest's RAM; it is not a GPU-only memory guarantee.
* gpu04's newer engine digest is
  `e9d29a1cb1cd65284392c4d62d5f2a36669628057e15c60fe93ea40cfe4fc7e7`.
  It additionally sets health/admission-reserve flags and prefill/decode interval
  absent in those gpu03 replica start actions. This review does not audit the
  source of these different engine images or their performance fixes.

The last registrar-only start uses
[HiCache at commit 5ba5a5b](https://github.com/nearai/cvm-compose-files/blob/5ba5a5bb92b7b1bbbe72fe9b7a8fbaec729627a1/prod/GLM-5.3-Flash-SGL-TP4-HiCache.yaml),
SHA-256 `9fbc74afdb7020125399bf52b8c20863575fe8c474bd2bb8c7056b27cdbef63f`.
That file contains newer r1/r2 images, but **a registrar-only action does not prove
those model images were restarted**. The profile pins the full history rather
than assuming every service now uses the latest file.

The intended HiCache service graph contains nginx → privileged proxy → two model
replicas, plus downloader, registrar, DCGM and OTel. Maintenance cleanup and
verification/soak helpers have explicit profiles. The last recorded soak start
has a corresponding teardown; a perception-check helper was started explicitly.
The proxy digest is
`b3a8c6260834231271b4356c56a7aa2718608c8a537b35973916e0a56dc88fba`, nginx is
`1d13701a5f9f3fb01aaa88cef2344d65b6b5bf6b7d9fa4cf0dca557a8d7702ba`.
The privileged proxy mounts the dstack socket and reads the TLS certificate volume;
these permissions and payload/transport configuration match gpu04. No newly
mutable image tag or in-CVM `build:` was found in the explicitly selected
historical start/stage services; the proxy was privileged in three earlier
immutable image versions too. This is a configuration review, not a claim that
privileged historical execution cannot have persistent effects.

## Why the exact active set cannot be reconstructed

The public action records do not include compose project, environment overrides,
resolved container config, success/exit status, or runtime container image IDs.
The [upstream manager source](https://github.com/nearai/compose-manager/blob/9412436404e99bb40d7a6fd192d3d1218ad64ce1/src/main.rs)
supports project/env overrides, but its `DeploymentAction` omits them. Actions
are recorded before the asynchronous Docker command completes. `compose_down`
does not clear its recorded deployment state. This source review is not a
verified reproducible build of the running manager digest.

Consequently, the sequence of different-file `compose_down` calls on September 17
cannot tell us which same-named services were removed: the missing project scope
matters. A failed operation can also appear in the history. We can reconstruct
declared operations, immutable file bytes, and the intended HiCache graph; we
cannot honestly label a derived set as the exact currently running services.

This limitation applies to gpu04 as well. Approving gpu03 for development means
accepting the existing explicit trust in NEAR's privileged control plane and its
measured guest, including shared cache volumes and manager assertions. Neither
profile establishes immutable-workload `codeHash`, byte-verified model weights,
an audited image build chain, or exclusion of privileged maintainers.

## Review decision

Approved for **development only** on 2026-09-19 after review of these limitations
and the pinned official HiCache configuration. The active policy now includes
the **entire** gpu03 profile as a second alternative; individual measurements
are never unioned. Its existing expiry remains `2026-09-26T16:48:57Z`, and
session lifetime remains at most 120 seconds. Strict current TCB, GPU,
history, and manager-image checks are unchanged. Any changed history or unknown
VM continues to fail closed. The candidate file remains expired for provenance.
