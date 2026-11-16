# Install in Safari on macOS

This download uses Safari's temporary web-extension loader. It does not need Xcode or an Apple Developer account, but Safari removes temporary extensions when you quit Safari or after 24 hours.

1. Download `PDG-Quantum-Combiner-Safari-macOS.zip` from the GitHub Releases page and extract it.
2. Open Safari, then choose **Safari → Settings → Advanced** and enable **Show features for web developers** if the Developer tab is not visible.
3. Open **Safari → Settings → Developer**. If Safari asks, allow unsigned extensions.
4. Choose **Add Temporary Extension…** and select the extracted `PDG-Quantum-Combiner-Safari` folder.
5. In Safari Settings, open **Extensions**, enable **PDG Quantum Combiner**, and approve its requested PDG API access if prompted.

The extension is removed when Safari quits or after 24 hours. Add it again after that. For persistent Safari distribution, Apple requires the extension to be packaged in a macOS app; see [Apple's packaging instructions](https://developer.apple.com/documentation/safariservices/packaging-a-web-extension-for-safari) and [distribution requirements](https://developer.apple.com/documentation/safariservices/distributing-your-safari-web-extension).
