// Pinned npm release artifacts for the remote host; never execute install scripts.
export const ptyPackages = {
  "node-pty": {
    url: "https://registry.npmjs.org/@lydell/node-pty/-/node-pty-1.1.0.tgz",
    sha256: "31b83edeff5c5a22293fe25f70202c5379b44c17ca3f6f37e9b5d5f584a37d27",
  },
  "node-pty-darwin-arm64": {
    url: "https://registry.npmjs.org/@lydell/node-pty-darwin-arm64/-/node-pty-darwin-arm64-1.1.0.tgz",
    sha256: "937a533814ddeb3eb1d6d7a84f5aa2302d73ffe69332a34a94ae05e9e203eab3",
  },
  "node-pty-darwin-x64": {
    url: "https://registry.npmjs.org/@lydell/node-pty-darwin-x64/-/node-pty-darwin-x64-1.1.0.tgz",
    sha256: "2a45297cec01dffa282f39cc1f87d1f2fa42e5c186e261ff88bfcfbce0186c00",
  },
  "node-pty-linux-arm64": {
    url: "https://registry.npmjs.org/@lydell/node-pty-linux-arm64/-/node-pty-linux-arm64-1.1.0.tgz",
    sha256: "c4ace306e4099a7919c7852fe29a6a9052f9d9b9eaf36617bf7c6cb72cd16118",
  },
  "node-pty-linux-x64": {
    url: "https://registry.npmjs.org/@lydell/node-pty-linux-x64/-/node-pty-linux-x64-1.1.0.tgz",
    sha256: "8d2e043026672f11aafd5f1a831f794a90d8fdd9d5e3255e8bc121df64b9d8e4",
  },
} as const;
