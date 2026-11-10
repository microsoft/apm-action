# Contributing to APM Action

This project welcomes contributions and suggestions. Most contributions require you to agree to a
Contributor License Agreement (CLA) declaring that you have the right to, and actually do, grant us
the rights to use your contribution. For details, visit https://cla.opensource.microsoft.com.

When you submit a pull request, a CLA bot will automatically determine whether you need to provide
a CLA and decorate the PR appropriately (e.g., status check, comment). Simply follow the instructions
provided by the bot. You will only need to do this once across all repos using our CLA.

This project has adopted the [Microsoft Open Source Code of Conduct](https://opensource.microsoft.com/codeofconduct/).
For more information see the [Code of Conduct FAQ](https://opensource.microsoft.com/codeofconduct/faq/) or
contact [opencode@microsoft.com](mailto:opencode@microsoft.com) with any additional questions or comments.

## Development

```sh
npm install        # install dependencies
npm run build      # compile with ncc → dist/
npm run typecheck   # tsc --noEmit
npm run lint       # eslint
npm run test       # jest
```

Source lives in `src/`. The compiled bundle in `dist/index.js` is what the action runs.

## License

APM-owned code and documentation are licensed under [Apache-2.0](LICENSE).
Third-party components retain their own licenses; keep
[`dist/licenses.txt`](dist/licenses.txt) with the compiled bundle.
[NOTICE](NOTICE) preserves Microsoft attribution and the historical MIT notice.
Previously published MIT releases remain under their original terms.
Redistributors updating to this version should review the Apache-2.0 terms and
retain the applicable license and notices.
