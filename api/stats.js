const LOGIN = process.env.MY_SITE_LOGIN;
const PASSWORD = process.env.MY_SITE_PASSWORD;
const POINT_ID = process.env.POINT_ID || "125014";

const API_HOST = `https://cabinet3.clientomer.ru/${POINT_ID}`;

const CACHE = {};
const CACHE_TTL = 2 * 60 * 1000;

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const mode = req.query.date || "today";
  const now = Date.now();

  if (CACHE[mode] && now - CACHE[mode].timestamp < CACHE_TTL) {
    return res.status(200).json(CACHE[mode].data);
  }

  try {
    const loginRes = await fetch(`${API_HOST}/jlogin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: `${API_HOST}/`
      },
      body: new URLSearchParams({
        login: LOGIN,
        password: PASSWORD,
        point: POINT_ID
      })
    });

    const cookie = loginRes.headers.get("set-cookie")?.split(";")[0];
    if (!cookie) throw new Error("Не получена кука сессии");

    const timestamp = Date.now();
    const apiUrl = `${API_HOST}/reserves.api.guestsreserves?timestamp=${timestamp}`;
    const apiRes = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "X-Requested-With": "XMLHttpRequest",
        Referer: `${API_HOST}/`
      }
    });

    const contentType = apiRes.headers.get("content-type");
    if (!contentType || !contentType.includes("application/json")) {
      const text = await apiRes.text();
      console.error(
        "Non-JSON response from Clientomer:",
        text.substring(0, 300)
      );
      throw new Error(
        "Сервер вернул не JSON (возможно, неверные данные или сессия)"
      );
    }

    const data = await apiRes.json();
    if (data.status !== "success") throw new Error("API вернул ошибку");

    // 3. Агрегация данных
    const nowMSK = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const targetDate = new Date(nowMSK);
    if (mode === "tomorrow") {
      targetDate.setDate(targetDate.getDate() + 1);
    }
    const targetDateStr = targetDate.toISOString().split("T")[0];

    let totalWaiting = 0;
    let bookings5to7 = 0;
    let bookings8plus = 0;
    const hourly = {};

    for (const reserve of data.data.reserves || []) {
      const date = reserve.estimated_time.split("T")[0];
      const status = reserve.inner_status;
      const guests = reserve.guests_count || 0;

      if (
        date === targetDateStr &&
        ["new", "waiting", "confirmed"].includes(status)
      ) {
        totalWaiting += guests;
        if (guests >= 5 && guests <= 7) bookings5to7++;
        if (guests >= 8) bookings8plus++;

        const hourPart = reserve.estimated_time.split("T")[1];
        if (hourPart) {
          const hour = hourPart.substring(0, 2);
          if (!hourly[hour]) {
            hourly[hour] = {
              count: 0,
              guests: 0,
              groups5to7: 0,
              groups8plus: 0
            };
          }
          hourly[hour].count += 1;
          hourly[hour].guests += guests;
          if (guests >= 5 && guests <= 7) hourly[hour].groups5to7 += 1;
          if (guests >= 8) hourly[hour].groups8plus += 1;
        }
      }
    }

    const sortedHours = Object.keys(hourly).sort();
    const hourlyList = sortedHours.map((h) => {
      const hData = hourly[h];
      const totalLarge = hData.groups5to7 + hData.groups8plus;

      let largeInfo = "–";
      if (totalLarge > 0) {
        const parts = [];
        if (hData.groups8plus > 0) {
          parts.push(
            `${hData.groups8plus} ${decline(
              hData.groups8plus,
              "компания",
              "компании",
              "компаний"
            )} (8+)`
          );
        }
        if (hData.groups5to7 > 0) {
          parts.push(
            `${hData.groups5to7} ${decline(
              hData.groups5to7,
              "компания",
              "компании",
              "компаний"
            )} (5–7)`
          );
        }
        largeInfo = parts.join(" / ");
      }

      return {
        hour: h,
        count: hData.count,
        guests: hData.guests,
        largeInfo
      };
    });

    const result = {
      waiting: totalWaiting,
      bookings5to7,
      bookings8plus,
      hourly: hourlyList
    };

    CACHE[mode] = { result, timestamp: now };
    res.status(200).json(result);
  } catch (err) {
    console.error("API error:", err.message);
    res.status(500).json({ error: err.message.substring(0, 200) });
  }
}

function decline(number, one, few, many) {
  let n = Math.abs(number) % 100;
  let n1 = n % 10;
  if (n > 10 && n < 20) return many;
  if (n1 > 1 && n1 < 5) return few;
  if (n1 === 1) return one;
  return many;
}
