# BirdNET+ V3.0 (admin test, DECISIONS.md #133)

Files served by the Birdbrain server at `/models/birdnet-v3.0/` (Nginx, like V2.4) and loaded only when the admin
picks "BirdNET+ V3.0" in Settings.

| File | Source (Zenodo record 24362980, version 3.0.1, DOI 10.5281/zenodo.24362980) |
| ---- | ---- |
| `audio.onnx` | `BirdNET+_V3.0_Global_12K_FP16.onnx` (full model, 11,725 classes, mixed precision) |
| `geo.onnx` | `BirdNET+_Geomodel_V3.0.5_Global_14K_FP16.onnx`, from `BirdNET+_Geomodel_V3.0.5_Global_14K.zip` |
| `ort-wasm-simd-threaded-1.31.1.wasm` | The ONNX Runtime Web 1.31.1 engine (MIT), copied from `node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm`; served here to keep the Vercel build small |
| `MODEL_LICENSE.txt` | Apache License 2.0 for the model weights, as shipped |
| `ACCEPTABLE_USE.txt` | The BirdNET V3.0 acceptable use policy, as shipped (guidance; adds no licence conditions) |

The two `.onnx` files are too big for GitHub (174 MB) and are not committed, nor is the engine file. Get them with

    scripts/fetch-model-v3.sh

which downloads them from Zenodo and checks them against `SHA256SUMS`. Then publish the folder to the server with

    scripts/server/publish-model.sh --version birdnet-v3.0 --dry-run
    scripts/server/publish-model.sh --version birdnet-v3.0

The label list the app uses is `public/models/birdnet-v3.0/labels.json`, made by `scripts/prepare-labels-v3.mts`.

Citation: Lasseck, M., Eibl, M., Klinck, H., & Kahl, S. (2026). BirdNET+ V3.0 model files (Version 3.0.1). Zenodo.
https://doi.org/10.5281/zenodo.24362980
