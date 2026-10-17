import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  { ignores: [".next/**", "node_modules/**", "drizzle/**", "next-env.d.ts", ".media/**", ".media-test/**", ".scratch/**", ".scratch-test/**", ".pgdata/**"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      // Server actions take (prevState, formData); an unused prevState is named "_".
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Apostrophes in copy are fine; still catch stray > and } in JSX text.
      "react/no-unescaped-entities": ["error", { forbid: [">", "}"] }],
    },
  },
];
export default config;
