function getSelectedMode() {
    return document.querySelector('input[name="searchMode"]:checked').value;
  }
  
  document.querySelectorAll('input[name="searchMode"]').forEach(radio => {
    radio.addEventListener("change", () => {
      const input = document.getElementById("classicQuery");
  
      input.placeholder =
        getSelectedMode() === "id"
          ? "Søk på ID-nummer"
          : "Søk etter dokumenter";
    });
  });
  
  async function runClassicSearch() {
    const input = document.getElementById("classicQuery");
    const resultsBox = document.getElementById("classicResults");
  
    const query = input.value.trim();
    const mode = getSelectedMode();
  
    if (!query) return;
  
    resultsBox.classList.remove("hidden");
    resultsBox.classList.add("searching");
  
    resultsBox.innerHTML = `
      <p class='placeholder'>
        SØKER <span class="spinner"></span>
      </p>
    `;
  
    try {
      const res = await fetch("/classic-search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, mode })
      });
  
      const data = await res.json();
  
      if (!data.results?.length) {
        resultsBox.innerHTML =
          "<p class='placeholder'>INGEN DOKUMENTER FUNNET</p>";
        return;
      }
  
      resultsBox.innerHTML = `
        <div class="results-list">
          ${data.results.map(doc => `
            <div class="result-item">
              <img src="./img/document_logo.svg" class="doc-icon">
              <div class="doc-info">
                <a href="${doc.url}" target="_blank">${doc.name}</a>
                <span>ID: ${doc.id}</span>
              </div>
            </div>
          `).join("")}
        </div>
      `;
  
      resultsBox.classList.remove("searching");
  
    } catch (err) {
      resultsBox.innerHTML =
        "<p class='placeholder'>NOE GIKK GALT</p>";
    }
  }
  
  document.getElementById("classicBtn")
    .addEventListener("click", runClassicSearch);
  
  document.getElementById("classicQuery")
    .addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        runClassicSearch();
      }
    });