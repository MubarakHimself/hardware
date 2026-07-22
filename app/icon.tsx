import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          alignItems: "center",
          background: "#18201c",
          display: "flex",
          height: "100%",
          justifyContent: "center",
          width: "100%",
        }}
      >
        <div
          style={{
            alignItems: "center",
            border: "2px solid #f4f0e6",
            borderRadius: "50%",
            display: "flex",
            height: 20,
            justifyContent: "center",
            width: 20,
          }}
        >
          <div
            style={{
              background: "#2d6a4f",
              borderRadius: "50%",
              display: "flex",
              height: 8,
              width: 8,
            }}
          />
        </div>
      </div>
    ),
    size,
  );
}
