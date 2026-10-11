import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

import { appName, repoUrl } from "./shared";

// The Cutword app icon; vector master in docs/brand/forge-cutword-app-icon.svg.
export function Wordmark() {
  return (
    <span className="inline-flex items-center gap-2 font-semibold tracking-[0.08em]">
      <svg aria-hidden className="size-5" viewBox="0 0 1024 1024">
        <path d="M0 0H1024V1024H0Z" fill="#17232D" />
        <path
          d="M0 0H92L69 27H24L4 45L24 42H69V66H28V100H0Z"
          fill="#F4F2ED"
          transform="translate(217.6 192) scale(6.4)"
        />
      </svg>
      {appName}
    </span>
  );
}

export function baseOptions(): BaseLayoutProps {
  return {
    githubUrl: repoUrl,
    links: [{ active: "nested-url", text: "Docs", url: "/docs" }],
    nav: {
      title: <Wordmark />,
    },
    themeSwitch: { mode: "light-dark" },
  };
}
