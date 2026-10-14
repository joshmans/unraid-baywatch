import App from "./App.svelte";

const target = document.getElementById("unraid-baywatch-app");

if (target) {
  new App({ target });
}
