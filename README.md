# Nexus PDF

Nexus PDF is a modern, privacy-first desktop PDF toolbox designed and maintained by **Nexus Bench**.

All document processing is performed **100% locally on your machine**—no cloud uploads, no telemetry, no tracking.

## Features

- **Document Reader**: Smooth, multi-layout PDF viewing (Single, Facing, Book, Continuous).
- **Watermarking**: 
  - Standard layer watermarks (lightweight vector overlay).
  - Raster tamper-proof watermarks (baked directly into page pixels to prevent removal).
- **Page Management**: Reorder, rotate, extract, or delete pages with live thumbnail previews.
- **Merge & Split**: Combine multiple documents or split pages into independent files.
- **Image Conversion**: High-fidelity export of PDF pages to image formats.
- **Compression**: Reduce document size with intelligent optimization.
- **Security**: Full PDF password protection, encryption, and decryption.

## Tech Stack

- **Framework**: [Tauri 2.0](https://tauri.app/) (Rust backend + Web frontend)
- **Frontend**: Vue 3, Vite
- **PDF Engines**: Mozilla `pdf.js` & `@cantoo/pdf-lib`

## Getting Started

### Prerequisites

- Node.js (v18+)
- Rust & Cargo
- Platform build dependencies (e.g., C++ build tools on Windows)

### Development

```bash
# Install root and frontend dependencies
npm install
npm install --prefix frontend

# Launch in development mode
npm run dev
```

### Build

```bash
# Compile release binaries and installers (.exe, .msi)
npm run build
```

## License

Distributed under the MIT License. See `LICENSE` for details.
