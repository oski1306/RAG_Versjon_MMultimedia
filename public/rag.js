function renderAnswer(answer, citations) {
    if (!answer) return "";
  
    const blocks = answer.split(/\n(?=\[\d+\])/);
  
    return blocks.map(block => {
      const lines = block.trim().split("\n");
  
      const titleLine = lines[0];
      const descLines = lines.splice(1);
  
      const match = titleLine.match(/^\[(\d+)\]\s*(.+)$/);
      if (!match) return "";
  
      const [, id, title] = match;
  
      const citation = citations.find(c => c.id == id);
      if (!citation) return "";
  
      const description = descLines.join(" ");
  
      const targetUrl = `/docs/${citation.path}`;
  
      return `
        <div class="rag-result">
          <div class="rag-result-content">
            <a href="${targetUrl}" target="_blank" title="${title}">
              ${title}
            </a>
            <p class="rag-desc">${description}</p>
            <span class="read-more">Vis mer</span>
          </div>
        </div>
      `;
    }).join("");
  }
  
  function toggleDesc(el) {
    const desc = el.parentElement.querySelector(".rag-desc");
    if (!desc) return;
  
    desc.classList.toggle("expanded");
  
    el.textContent =
      desc.classList.contains("expanded")
        ? "Vis mindre"
        : "Vis mer";
  }
  
  function updatedReadMoreVisibility() {
    document.querySelectorAll(".rag-desc").forEach(desc => {
      const readMore = desc.parentElement.querySelector(".read-more");
      if (!readMore) return;
  
      const wasExpanded = desc.classList.contains("expanded");
  
      desc.classList.add("expanded");
      const fullHeight = desc.scrollHeight;
  
      if (!wasExpanded) desc.classList.remove("expanded");
  
      if (fullHeight <= desc.clientHeight + 2) {
        readMore.style.display = "none";
        desc.classList.remove("clamped");
      } else {
        readMore.style.display = "inline-block";
        desc.classList.add("clamped");
      }
    });
  }

  function renderSkeletonResults(count = 1) {
    return `
      <div class="rag-answer">
        ${Array.from({ length: count }).map(() => `
          <div class="rag-result skeleton-result">
            <div class="rag-result-content">
              <div class="skeleton skeleton-title"></div>
              <div class="skeleton skeleton-desc"></div>
              <div class="skeleton skeleton-readmore"></div>
            </div>
          </div>
        `).join("")}
      </div>
    `;
  }
  
  function restartSkeletonAnimation() {
    document.querySelectorAll(".skeleton").forEach(el => {
      el.style.animation = "none";
      el.offsetHeight;
      el.style.animation = "";
    });
  }
  
  async function loadPositions() {
    const select = document.getElementById("position-filter");
    const dropdown = document.getElementById("positionDropdown");

    if (!select || !dropdown) {
      console.err("Dropdown elements not found!")
      return;
    }

    const optionsContainer = dropdown.querySelector(".dropdown-options");
    const selectedText = dropdown.querySelector(".selected-text");

    if (!optionsContainer || !selectedText) {
      console.error("Dropdown structure incorrect!")
      return;
    }

    optionsContainer.innerHTML = "";

    const defaultDiv = document.createElement("div");
    defaultDiv.classList.add("dropdown-option", "selected");
    defaultDiv.textContent = "ALLE DOKUMENTER";

    selectedText.textContent = "ALLE DOKUMENTER";
    select.value = "ALL";

    defaultDiv.addEventListener("click", () => {
      selectedText.textContent = "ALLE DOKUMENTER";
      select.value = "ALL";

      document.querySelectorAll(".dropdown-option")
       .forEach(opt => opt.classList.remove("selected"));

       defaultDiv.classList.add("selected");
       dropdown.classList.remove("open");
    });

    optionsContainer.appendChild(defaultDiv);

    try {
      const res = await fetch("/positions");
      const positions = await res.json();

      positions.forEach(pos => {
        const option = document.createElement("option");
        option.value = pos;
        option.textContent = pos;
        select.appendChild(option);

        const div = document.createElement("div");
        div.classList.add("dropdown-option");
        div.textContent = pos;

        div.addEventListener("click", () => {
          selectedText.textContent = pos;
          select.value = pos;

          document.querySelectorAll(".dropdown-option")
           .forEach(opt => opt.classList.remove("selected"));
          
          div.classList.add("selected");
          dropdown.classList.remove("open");
        });

        optionsContainer.appendChild(div);
      })

    } catch (err) {
      console.error("Failed loading positions", err);
    }

    dropdown.querySelector(".dropdown-selected")
     .addEventListener("click", () => {
      dropdown.classList.toggle("open");
     });

     document.addEventListener("click", (e) => {
      if (!dropdown.contains(e.target)) {
        dropdown.classList.remove("open")
      }
     });
  }
  
  async function askQuestion() {
    const input = document.getElementById("question");
    const box = document.getElementById("chat-box");
    const button = document.getElementById("askBtn");
    const positionFilter = document.getElementById("position-filter").value;
  
    const q = input.value.trim();
    if (!q) return;
  
    box.classList.remove("compact", "expanded");
    box.classList.add("compact");
    box.innerHTML = renderSkeletonResults(1);
  
    input.disabled = true;
    button.disabled = true;
  
    try {
      const response = await fetch("/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: q,
          position: positionFilter
        })
      });
  
      const data = await response.json();
      const citations = data.citations || [];
  
      if (!data.answer || !citations.length) {
        restartSkeletonAnimation();
  
        setTimeout(() => {
          box.innerHTML = `
            <p class="placeholder">
              INGEN DOKUMENTER FUNNET
            </p>
          `;
        }, 180);
  
        return;
      }
  
      const rendered = renderAnswer(data.answer, citations);
  
      restartSkeletonAnimation();
  
      setTimeout(() => {
        box.classList.remove("compact");
  
        if (citations.length > 1) {
          box.classList.add("expanded");
        }
  
        box.innerHTML = `
          <div class="rag-answer">
            ${rendered}
          </div>
        `;
  
        document.querySelectorAll(".read-more").forEach(el =>
          el.addEventListener("click", () => toggleDesc(el))
        );
  
        requestAnimationFrame(updatedReadMoreVisibility);
      }, 180);
  
    } catch (err) {
      box.innerHTML = "<p class='placeholder'>NOE GIKK GALT</p>";
    } finally {
      input.disabled = false;
      button.disabled = false;
      input.value = "";
      input.focus();
    }
  }
  
  document.getElementById("askBtn")
    .addEventListener("click", askQuestion);
  
  document.getElementById("question")
    .addEventListener("keydown", e => {
      if (e.key === "Enter") {
        e.preventDefault();
        askQuestion();
      }
    });
  
  loadPositions();