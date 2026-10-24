# Seolyticize SEO check

`github-action/` fails a pull request whose deploy preview would break SEO. It calls `check_deploy`, which fetches the preview (one or more pages per template from the latest crawl) and compares status, robots, canonical, hreflang, title, H1 and structured data with production, then comments the differences on the pull request. It needs an API key with project:manage on the client, kept in a secret.

```yaml
on: pull_request
permissions:
  pull-requests: write
jobs:
  seo:
    runs-on: ubuntu-latest
    steps:
      - uses: Seolyticize/github-action@v1
        with:
          api-key: ${{ secrets.SEOLYTICIZE_API_KEY }}
          client-id: <client id>
          preview-url: https://pr-${{ github.event.number }}.example.vercel.app
```

Use `urls` instead of `preview-url` for specific addresses, `fail-on: warning` to be stricter, and `baseline-crawl-id` to compare against a chosen crawl (say, the one taken after the last release) instead of the latest.

MIT licensed. Published from the Seolyticize monorepo.
