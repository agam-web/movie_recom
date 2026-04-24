

import difflib
import os
import time

import numpy as np
import pandas as pd
from flask import Flask, jsonify, request, render_template
from flask_cors import CORS
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity

# ── App setup ─────────────────────────────────────────────────────────────────
app = Flask(__name__)
CORS(app)

app.config["CSV_PATH"] = os.environ.get("MOVIES_CSV", "Data/movies.csv")
app.config["TOP_N"]    = int(os.environ.get("TOP_N", 30))

# ── Global model state ────────────────────────────────────────────────────────
model = {
    "movies_data":       None,
    "similarity_matrix": None,
    "vectorizer":        None,
    "titles":            [],
    "loaded_at":         None,
    "num_movies":        0,
    "vocab_size":        0,
}

SELECTED_FEATURES = ["genres", "keywords", "tagline", "cast", "director"]


# ── Model initialisation ──────────────────────────────────────────────────────

def load_model(csv_path: str):
    """Load CSV, build TF-IDF vectors and cosine-similarity matrix at startup."""
    movies_data = pd.read_csv(csv_path)

    for feature in SELECTED_FEATURES:
        if feature in movies_data.columns:
            movies_data[feature] = movies_data[feature].fillna("")
        else:
            movies_data[feature] = ""

    movies_data["combined"] = (
        movies_data["genres"]   + " " +
        movies_data["keywords"] + " " +
        movies_data["tagline"]  + " " +
        movies_data["cast"]     + " " +
        movies_data["director"]
    )

    vectorizer      = TfidfVectorizer(stop_words="english", max_features=5000)
    feature_vectors = vectorizer.fit_transform(movies_data["combined"])
    similarity_matrix = cosine_similarity(feature_vectors)

    model["movies_data"]       = movies_data
    model["similarity_matrix"] = similarity_matrix
    model["vectorizer"]        = vectorizer
    model["titles"]            = [str(t) for t in movies_data["title"].tolist()]
    model["loaded_at"]         = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    model["num_movies"]        = len(movies_data)
    model["vocab_size"]        = len(vectorizer.vocabulary_)

    print(f"[CineMatch] Loaded {model['num_movies']} movies | "
          f"vocab size: {model['vocab_size']}")


# ── Recommendation helper ─────────────────────────────────────────────────────

def get_recommendations(movie_name: str, top_n: int = None):
    """Return (matched_title, recommendations_list, error_string)."""
    if model["movies_data"] is None:
        return None, [], "Model not loaded."

    top_n = top_n or app.config["TOP_N"]

    close_matches = difflib.get_close_matches(
        movie_name, model["titles"], n=5, cutoff=0.4
    )
    if not close_matches:
        return None, [], f"No close match found for '{movie_name}'."

    matched_title = close_matches[0]
    movies_data   = model["movies_data"]

    mask = movies_data["title"].astype(str) == matched_title
    if not mask.any():
        return matched_title, [], "Matched title not found in dataset."

    movie_index     = movies_data[mask].index[0]
    similarity_scores = list(enumerate(model["similarity_matrix"][movie_index]))
    sorted_scores   = sorted(similarity_scores, key=lambda x: x[1], reverse=True)

    recommendations = []
    for rank, (idx, score) in enumerate(sorted_scores[1: top_n + 1], start=1):
        row = movies_data.iloc[idx]
        recommendations.append({
            "rank":     rank,
            "title":    str(row.get("title", "")),
            "genres":   str(row.get("genres", "")),
            "director": str(row.get("director", "")),
            "cast":     str(row.get("cast", "")),
            "tagline":  str(row.get("tagline", "")),
            "score":    round(float(score), 4),
        })

    return matched_title, recommendations, None


# ══════════════════════════════════════════════════════════════════════════════
#  ROUTES
# ══════════════════════════════════════════════════════════════════════════════

@app.route("/", methods=["GET"])
def index():
    """Serve the frontend. Pass dataset stats so the page can display them."""
    return render_template(
        "index.html",
        num_movies=model["num_movies"],
        loaded_at=model["loaded_at"],
    )


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status":       "ok",
        "model_loaded": model["movies_data"] is not None,
        "num_movies":   model["num_movies"],
        "loaded_at":    model["loaded_at"],
    }), 200


@app.route("/stats", methods=["GET"])
def stats():
    if model["movies_data"] is None:
        return jsonify({"error": "Model not loaded."}), 503

    df = model["movies_data"]
    return jsonify({
        "num_movies":              model["num_movies"],
        "vocab_size":              model["vocab_size"],
        "features_used":           SELECTED_FEATURES,
        "columns_available":       df.columns.tolist(),
        "loaded_at":               model["loaded_at"],
        "similarity_matrix_shape": list(model["similarity_matrix"].shape),
    }), 200


@app.route("/movies", methods=["GET"])
def list_movies():
    if model["movies_data"] is None:
        return jsonify({"error": "Model not loaded."}), 503

    page  = max(1, int(request.args.get("page",  1)))
    limit = min(200, max(1, int(request.args.get("limit", 50))))
    start = (page - 1) * limit
    end   = start + limit
    titles = model["titles"]

    return jsonify({
        "page":        page,
        "limit":       limit,
        "total":       len(titles),
        "total_pages": -(-len(titles) // limit),
        "movies":      titles[start:end],
    }), 200


@app.route("/movies/search", methods=["GET"])
def search_movies():
    if model["movies_data"] is None:
        return jsonify({"error": "Model not loaded."}), 503

    query = request.args.get("q", "").strip()
    if not query:
        return jsonify({"error": "Query parameter 'q' is required."}), 400

    limit   = min(20, max(1, int(request.args.get("limit", 8))))
    matches = difflib.get_close_matches(query, model["titles"], n=limit, cutoff=0.3)

    return jsonify({"query": query, "matches": matches, "count": len(matches)}), 200


@app.route("/recommend", methods=["POST"])
def recommend():
    if model["movies_data"] is None:
        return jsonify({"error": "Model not loaded."}), 503

    body = request.get_json(silent=True)
    if not body:
        return jsonify({"error": "Request body must be JSON."}), 400

    movie_name = body.get("movie", "").strip()
    if not movie_name:
        return jsonify({"error": "Field 'movie' is required."}), 400

    top_n = max(1, min(100, int(body.get("top_n", app.config["TOP_N"]))))
    matched_title, recommendations, error = get_recommendations(movie_name, top_n)

    if error:
        return jsonify({"error": error, "query": movie_name}), 404

    return jsonify({
        "query":           movie_name,
        "matched":         matched_title,
        "count":           len(recommendations),
        "recommendations": recommendations,
    }), 200


# ── Error handlers ────────────────────────────────────────────────────────────
@app.errorhandler(404)
def not_found(e):
    return jsonify({"error": "Endpoint not found."}), 404

@app.errorhandler(405)
def method_not_allowed(e):
    return jsonify({"error": "Method not allowed."}), 405

@app.errorhandler(500)
def server_error(e):
    return jsonify({"error": "Internal server error.", "details": str(e)}), 500


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == "__main__":
    csv_path = app.config["CSV_PATH"]
    if not os.path.exists(csv_path):
        print(f"[ERROR] '{csv_path}' not found. "
              f"Set the MOVIES_CSV env var or place movies.csv inside Data/")
    else:
        load_model(csv_path)

    app.run(
        host  = os.environ.get("HOST", "0.0.0.0"),
        port  = int(os.environ.get("PORT", 5000)),
        debug = os.environ.get("FLASK_DEBUG", "false").lower() == "true",
    )
