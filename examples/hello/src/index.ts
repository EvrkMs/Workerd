export default {
  async fetch(request) {
    const url = new URL(request.url);
    return Response.json({
      hello: "workerd test",
      path: url.pathname,
      time: new Date().toISOString(),
    });
  },
} satisfies ExportedHandler;
