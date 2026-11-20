/**
 * A page's own form, posted by the browser: that happens only before the page has hydrated, or
 * without script, as React handles every submit once it has. The answer is the page again, by
 * GET, with nothing of what was posted. The forms that hold a URL, an email or a secret post
 * (`method="post"`), so a value typed there never reaches the address bar, history, a Referer or
 * the Worker's request logs, as a GET's query would.
 */
export const backToPage = {
  POST: ({ request }: { request: Request }) => {
    const url = new URL(request.url);
    return new Response(null, { status: 303, headers: { location: url.pathname + url.search } });
  },
};
