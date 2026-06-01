import "dotenv/config";
import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFileSync } from "fs";
import crypto from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 8888;

const PAYPAL_API = process.env.PAYPAL_ENV === "production"
  ? "https://api-m.paypal.com"
  : "https://api-m.sandbox.paypal.com";

app.use(express.json());

// index.html のみ CLIENT_ID を動的に差し込む
app.get("/", (req, res) => {
  const html = readFileSync(join(__dirname, "public", "index.html"), "utf-8")
    .replace("__CLIENT_ID__", process.env.PAYPAL_CLIENT_ID || "");
  res.type("html").send(html);
});

app.use(express.static(join(__dirname, "public")));

// OAuth2 アクセストークン取得
async function getAccessToken() {
  const credentials = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString("base64");

  const res = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token fetch failed: ${err}`);
  }

  const { access_token } = await res.json();
  return access_token;
}

// Setup Token 作成
// POST /api/vault/setup-token
app.post("/v3/vault/setup-token", async (req, res) => {
  try {
    const accessToken = await getAccessToken();
    const { customer_id, verification_method = "SCA_WHEN_REQUIRED" } = req.body;

    const paymentSource = {
      card: {
        verification_method,
        experience_context: {
          return_url: `${process.env.BASE_URL}/vault/success`,
          cancel_url: `${process.env.BASE_URL}/vault/cancel`,
        },
      },
    };

    const body = { payment_source: paymentSource };
    if (customer_id) {
      body.customer = { id: customer_id };
    }

    const vaultRes = await fetch(`${PAYPAL_API}/v3/vault/setup-tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    });

    const data = await vaultRes.json();

    if (!vaultRes.ok) {
      console.error("Setup token error:", data);
      return res.status(vaultRes.status).json(data);
    }

    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Setup Token → Payment Token 変換
// POST /api/vault/payment-token
app.post("/api/vault/payment-token", async (req, res) => {
  try {
    const accessToken = await getAccessToken();
    const { vaultSetupToken } = req.body;

    if (!vaultSetupToken) {
      return res.status(400).json({ error: "vaultSetupToken is required" });
    }

    const tokenRes = await fetch(`${PAYPAL_API}/v3/vault/payment-tokens`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": crypto.randomUUID(),
      },
      body: JSON.stringify({
        payment_source: {
          token: {
            id: vaultSetupToken,
            type: "SETUP_TOKEN",
          },
        },
      }),
    });

    const data = await tokenRes.json();

    if (!tokenRes.ok) {
      console.error("Payment token error:", data);
      return res.status(tokenRes.status).json(data);
    }

    // ここで data.id (payment token) と data.customer.id を保存する
    console.log("Payment token created:", data.id, "Customer:", data.customer?.id);

    res.json({
      paymentTokenId: data.id,
      customerId: data.customer?.id,
      card: data.payment_source?.card,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Setup Token の状態確認（デバッグ用）
// GET /api/vault/setup-token/:id
app.get("/api/vault/setup-token/:id", async (req, res) => {
  try {
    const accessToken = await getAccessToken();
    const tokenRes = await fetch(
      `${PAYPAL_API}/v3/vault/setup-tokens/${req.params.id}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    const data = await tokenRes.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3DS return_url / cancel_url
app.get("/vault/success", (req, res) => {
  res.sendFile(join(__dirname, "public", "vault-result.html"));
});
app.get("/vault/cancel", (req, res) => {
  res.sendFile(join(__dirname, "public", "vault-result.html"));
});

app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);
  console.log(`PayPal API: ${PAYPAL_API}`);
});
