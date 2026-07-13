import { appConfig } from "../config";
import { createGeminiClient, isAlabsQuotaExhausted } from "./gemini";

interface AlabsImageResponse {
  choices?: Array<{
    message?: {
      content?: string;
      images?: Array<{
        type?: string;
        image_url?: {
          url?: string;
        };
      }>;
    };
  }>;
}

type ImageMessageContentPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image_url";
      image_url: {
        url: string;
      };
    };

const IMAGE_MODEL_FALLBACKS = [
  appConfig.imageModel,
  "google/gemini-3.1-flash-lite-image",
];
const IMAGE_REQUEST_TIMEOUT_MS = 30_000;

type ImageRequestShape = {
  modalities?: string[];
  image_config?: {
    aspect_ratio: string;
  };
};

const IMAGE_REQUEST_SHAPES: ImageRequestShape[] = [
  { modalities: ["image", "text"], image_config: { aspect_ratio: "1:1" } },
  { modalities: ["image"], image_config: { aspect_ratio: "1:1" } },
  { image_config: { aspect_ratio: "1:1" } },
];

function uniqueModels(models: string[]): string[] {
  return [...new Set(models.filter(Boolean))];
}

export interface GeneratedImage {
  buffer: Buffer;
  filename: string;
}

export interface GenerateImageOptions {
  imageUrls?: string[];
}

function normalizeImageUrls(imageUrls: string[]): string[] {
  return [...new Set(imageUrls.map((url) => url.trim()).filter(Boolean))];
}

function buildImageRequestContent(prompt: string, imageUrls: string[]): string | ImageMessageContentPart[] {
  const normalizedImageUrls = normalizeImageUrls(imageUrls);
  if (normalizedImageUrls.length === 0) {
    return prompt;
  }

  return [
    {
      type: "text",
      text: `${prompt}\n\nUse the attached image(s) as reference input.`,
    },
    ...normalizedImageUrls.map((url) => ({
      type: "image_url" as const,
      image_url: {
        url,
      },
    })),
  ];
}

function extractImageUrl(result: AlabsImageResponse): string | undefined {
  const message = result.choices?.[0]?.message;
  const fromImages = message?.images?.[0]?.image_url?.url;
  if (fromImages) {
    return fromImages;
  }

  const content = message?.content?.trim();
  if (!content) {
    return undefined;
  }

  const dataUrlMatch = content.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=\n\r]+/);
  if (dataUrlMatch?.[0]) {
    return dataUrlMatch[0].replace(/\s+/g, "");
  }

  const httpsMatch = content.match(/https?:\/\/\S+/);
  return httpsMatch?.[0];
}

async function generateImageFromGemini(prompt: string, imageUrls: string[]): Promise<GeneratedImage> {
  const client = createGeminiClient();
  if (!client) {
    throw new Error(
      "ALabs AI SDK image quota appears exhausted and no GEMINI_API_KEY* fallback keys are configured.",
    );
  }

  const parts: Array<{ text: string } | { fileData: { mimeType: string; fileUri: string } }> = [
    { text: prompt },
  ];

  for (const imageUrl of normalizeImageUrls(imageUrls)) {
    parts.push({
      fileData: {
        mimeType: "image/*",
        fileUri: imageUrl,
      },
    });
  }

  const response = (await client.models.generateContent({
    model: appConfig.geminiImageModel,
    contents: [{ role: "user", parts }],
    config: {
      responseModalities: ["TEXT", "IMAGE"],
    },
  })) as any;

  const candidateParts = (response?.candidates ?? [])
    .flatMap((candidate: any) => candidate?.content?.parts ?? [])
    .filter(Boolean);

  const inlineImagePart = candidateParts.find((part: any) => part?.inlineData?.data);
  const base64Data: string | undefined = inlineImagePart?.inlineData?.data;
  if (!base64Data) {
    throw new Error("Gemini fallback did not return an inline image payload.");
  }

  return {
    buffer: Buffer.from(base64Data, "base64"),
    filename: "generated.png",
  };
}

export async function generateImage(
  prompt: string,
  options: GenerateImageOptions = {},
): Promise<GeneratedImage> {
  let firstImage: string | undefined;
  let lastError: string | undefined;
  const imageUrls = normalizeImageUrls(options.imageUrls ?? []);
  const content = buildImageRequestContent(prompt, imageUrls);

  for (const modelId of uniqueModels(IMAGE_MODEL_FALLBACKS)) {
    for (const shape of IMAGE_REQUEST_SHAPES) {
      const response = await fetch(`${appConfig.aiBaseUrl}/chat/completions`, {
        method: "POST",
        signal: AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${appConfig.aiApiKey}`,
        },
        body: JSON.stringify({
          model: modelId,
          messages: [
            {
              role: "user",
              content,
            },
          ],
          ...shape,
          stream: false,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (isAlabsQuotaExhausted(response.status, errorText)) {
          return generateImageFromGemini(prompt, imageUrls);
        }

        lastError = `model=${modelId} status=${response.status} body=${errorText}`;
        continue;
      }

      const result = (await response.json()) as AlabsImageResponse;
      firstImage = extractImageUrl(result);
      if (firstImage) {
        break;
      }

      lastError = `model=${modelId} returned no image payload`;
    }

    if (firstImage) {
      break;
    }
  }

  if (!firstImage) {
    throw new Error(
      `Image generation failed across configured models. ${lastError ?? "No image payload returned."}`,
    );
  }

  const base64Prefix = "data:image/png;base64,";
  if (firstImage.startsWith(base64Prefix)) {
    const raw = firstImage.slice(base64Prefix.length);
    return {
      buffer: Buffer.from(raw, "base64"),
      filename: "generated.png",
    };
  }

  if (firstImage.startsWith("data:image/")) {
    const [, encoded] = firstImage.split(",", 2);
    if (!encoded) {
      throw new Error("Image generation failed: invalid data URL payload");
    }

    return {
      buffer: Buffer.from(encoded, "base64"),
      filename: "generated.png",
    };
  }

  if (firstImage.startsWith("http://") || firstImage.startsWith("https://")) {
    const remoteResponse = await fetch(firstImage, {
      signal: AbortSignal.timeout(IMAGE_REQUEST_TIMEOUT_MS),
    });
    if (!remoteResponse.ok) {
      throw new Error(
        `Image generation failed while downloading remote asset (${remoteResponse.status}).`,
      );
    }

    const arrayBuffer = await remoteResponse.arrayBuffer();
    return {
      buffer: Buffer.from(arrayBuffer),
      filename: "generated.png",
    };
  }

  throw new Error("Image generation failed: unsupported image payload");
}
