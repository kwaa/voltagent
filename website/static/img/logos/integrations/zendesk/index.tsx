import React from "react";

export const ZendeskLogo = ({ className }: { className?: string }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 1024 1024"
      enableBackground="new 0 0 1024 1024"
      className={className}
      aria-labelledby="zendeskLogoTitle"
    >
      <title id="zendeskLogoTitle">Zendesk Logo</title>
      <circle cx="512" cy="512" fill="#03363d" r="512" />
      <path
        d="m495.1 432v247.3h-204.8zm0-88.7c0 56.6-45.8 102.4-102.4 102.4s-102.4-45.8-102.4-102.4zm33.8 336c0-56.6 45.8-102.4 102.4-102.4s102.4 45.8 102.4 102.4zm0-88.8v-247.2h204.8z"
        fill="#fff"
        transform="translate(.00112 .736381)"
      />
    </svg>
  );
};
