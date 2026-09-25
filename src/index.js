export default {
  async fetch(request, env, ctx) {
    return new Response("N's Garage Worker OK", {
      headers: {
        "content-type": "text/plain; charset=UTF-8",
      },
    });
  },
};
