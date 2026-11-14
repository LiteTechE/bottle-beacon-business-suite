<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## STOREMAX Architecture
- The public `/scan` Mini App sends scanned barcodes through Telegram `web_app_data`; the existing Telegram webhook validates updates and forwards codes into the authenticated sale-search session so browser access never receives privileged inventory access.
