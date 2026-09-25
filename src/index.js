const cache = caches.default;

let originCache = {};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    // 動作確認用
    if (url.pathname === "/") {
      return jsonResponse(
        {
          ok: true,
          service: "N's Garage Travel Estimate API",
        },
        200,
        corsHeaders
      );
    }

    if (url.pathname !== "/estimate") {
      return jsonResponse(
        { ok: false, error: "Not Found" },
        404,
        corsHeaders
      );
    }

    if (!env.GEOAPIFY_API_KEY) {
      return jsonResponse(
        {
          ok: false,
          error: "Geoapify API key is not configured.",
        },
        500,
        corsHeaders
      );
    }

    const postcode = (url.searchParams.get("postcode") || "").trim();
    const mode = (url.searchParams.get("mode") || "monday").trim();

    // 郵便番号はハイフンなし7桁のみ
    if (!/^\d{7}$/.test(postcode)) {
      return jsonResponse(
        {
          ok: false,
          error: "郵便番号をハイフンなし7桁で入力してください。",
        },
        400,
        corsHeaders
      );
    }

    if (!["monday", "adachi"].includes(mode)) {
      return jsonResponse(
        {
          ok: false,
          error: "施工モードが正しくありません。",
        },
        400,
        corsHeaders
      );
    }

    // 同じ郵便番号・施工モードの連続照会をキャッシュ
    const cacheKey = new Request(
      `${url.origin}/estimate-cache?postcode=${postcode}&mode=${mode}`
    );

    const cached = await cache.match(cacheKey);

    if (cached) {
      const cachedBody = await cached.text();

      return new Response(cachedBody, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Cache": "HIT",
        },
      });
    }

    try {
      // ----------------------------
      // 1. ZipCloud 郵便番号 → 住所
      // ----------------------------
      const zipUrl =
        `https://zipcloud.ibsnet.co.jp/api/search?zipcode=${encodeURIComponent(postcode)}`;

      const zipRes = await fetch(zipUrl);

      if (!zipRes.ok) {
        throw new Error("郵便番号検索サービスに接続できませんでした。");
      }

      const zipData = await zipRes.json();

      if (
        !zipData.results ||
        !Array.isArray(zipData.results) ||
        zipData.results.length === 0
      ) {
        return jsonResponse(
          {
            ok: false,
            error: "郵便番号から住所を確認できませんでした。",
          },
          404,
          corsHeaders
        );
      }

      const zip = zipData.results[0];

      const address =
        `${zip.address1 || ""}${zip.address2 || ""}${zip.address3 || ""}`;

      // ----------------------------
      // 2. Geoapify 住所 → 緯度経度
      // ----------------------------
      const destination = await geocode(
        address,
        env.GEOAPIFY_API_KEY
      );

      if (!destination) {
        return jsonResponse(
          {
            ok: false,
            error: "施工場所の位置を確認できませんでした。",
          },
          404,
          corsHeaders
        );
      }

      // ----------------------------
      // 3. 出発地点
      // ----------------------------
      const originText =
        mode === "adachi"
          ? "東京都足立区"
          : "神奈川県横浜市緑区";

      let origin = originCache[mode];

      if (!origin) {
        origin = await geocode(
          originText,
          env.GEOAPIFY_API_KEY
        );

        if (!origin) {
          throw new Error("出発地点を取得できませんでした。");
        }

        originCache[mode] = origin;
      }

      // ----------------------------
      // 4. 車ルート距離
      // ----------------------------
      const routeUrl =
        "https://api.geoapify.com/v1/routing" +
        `?waypoints=${origin.lat},${origin.lon}|${destination.lat},${destination.lon}` +
        "&mode=drive" +
        "&units=metric" +
        `&apiKey=${encodeURIComponent(env.GEOAPIFY_API_KEY)}`;

      const routeRes = await fetch(routeUrl);

      if (!routeRes.ok) {
        throw new Error("ルート検索に失敗しました。");
      }

      const routeData = await routeRes.json();

      const feature =
        routeData.features &&
        routeData.features[0];

      const distanceMeters =
        feature &&
        feature.properties &&
        feature.properties.distance;

      if (
        typeof distanceMeters !== "number" ||
        !Number.isFinite(distanceMeters)
      ) {
        throw new Error("距離を取得できませんでした。");
      }

      const distanceKm =
        Math.round((distanceMeters / 1000) * 10) / 10;

      // 10kmごとに1,000円
      const travelFee =
        distanceKm <= 0
          ? 0
          : Math.ceil(distanceKm / 10) * 1000;

      const isAdachiOver =
        mode === "adachi" && distanceKm > 20;

      const isFar =
        mode === "monday" && distanceKm > 50;

      const result = {
        ok: true,
        postcode,
        address,
        mode,
        origin:
          mode === "adachi"
            ? "東京都足立区"
            : "神奈川県横浜市緑区",
        distanceKm,
        travelFee,
        travelFeeText:
          `${travelFee.toLocaleString("ja-JP")}円`,
        adachiConsultationRequired: isAdachiOver,
        farDistance: isFar,
        notes: [],
      };

      if (mode === "adachi") {
        result.notes.push(
          "足立区周辺の夜間施工は軽微な補修のみ・要相談です。"
        );

        if (isAdachiOver) {
          result.notes.push(
            "片道20kmを超えるため、対応可否を個別にご相談ください。"
          );
        }
      }

      if (isFar) {
        result.notes.push(
          "片道50kmを超えるため、施工内容に応じて遠方割引を適用できる場合があります。"
        );
      }

      result.notes.push(
        "高速道路・有料道路・有料駐車場を利用する場合は別途実費です。"
      );

      result.notes.push(
        "郵便番号を基準にした概算です。正式な金額は施工場所の住所確認後にご案内します。"
      );

      const body = JSON.stringify(result);

      const responseToCache = new Response(body, {
        status: 200,
        headers: {
          "Content-Type": "application/json; charset=UTF-8",
          "Cache-Control": "public, max-age=3600",
        },
      });

      await cache.put(cacheKey, responseToCache.clone());

      return new Response(body, {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json; charset=UTF-8",
          "Cache-Control": "public, max-age=3600",
          "X-Cache": "MISS",
        },
      });
    } catch (error) {
      console.error(error);

      return jsonResponse(
        {
          ok: false,
          error: "概算出張費を計算できませんでした。時間をおいて再度お試しください。",
        },
        500,
        corsHeaders
      );
    }
  },
};

async function geocode(text, apiKey) {
  const params = new URLSearchParams({
    text,
    format: "json",
    limit: "1",
    filter: "countrycode:jp",
    lang: "ja",
    apiKey,
  });

  const res = await fetch(
    `https://api.geoapify.com/v1/geocode/search?${params.toString()}`
  );

  if (!res.ok) {
    return null;
  }

  const data = await res.json();

  if (
    !data.results ||
    !Array.isArray(data.results) ||
    data.results.length === 0
  ) {
    return null;
  }

  const item = data.results[0];

  if (
    typeof item.lat !== "number" ||
    typeof item.lon !== "number"
  ) {
    return null;
  }

  return {
    lat: item.lat,
    lon: item.lon,
  };
}

function jsonResponse(data, status, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...extraHeaders,
      "Content-Type": "application/json; charset=UTF-8",
    },
  });
}