import DashboardWidget from "./DashboardWidget.svelte";

const target = document.getElementById("unraid-baywatch-dashboard");

if (target) {
  new DashboardWidget({ target });
}
