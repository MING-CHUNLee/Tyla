#* Tyla Plumber API
#*
#* API endpoints for the Tyla CLI to communicate with RStudio.
#*
#* @apiTitle Tyla R Bridge API
#* @apiDescription Execute R code in RStudio session via HTTP API

# Load package functions
library(tyla)

#* Enable CORS for all endpoints
#* @filter cors
function(req, res) {
    res$setHeader("Access-Control-Allow-Origin", "*")
    res$setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    res$setHeader("Access-Control-Allow-Headers", "Content-Type")

    if (req$REQUEST_METHOD == "OPTIONS") {
        res$status <- 200
        return(list())
    }

    plumber::forward()
}

#* Get server status
#* @get /status
#* @serializer json
function() {
    status <- tyla::server_status()
    list(
        running = status$running,
        sessionId = as.character(status$session_id),
        rVersion = status$r_version,
        uptime = if (!is.na(status$uptime)) round(status$uptime, 2) else NULL
    )
}

#* Execute R code
#* @post /execute
#* @param code:character The R code to execute
#* @param confirm_required:logical Whether confirmation is required
#* @serializer json
function(req, res, code = "", confirm_required = FALSE) {
    # Validate input
    if (is.null(code) || code == "") {
        res$status <- 400
        return(list(
            error = "Missing required parameter: code"
        ))
    }

    # Generate execution ID
    id <- uuid::UUIDgenerate()

    # For now, execute immediately (confirmation handled client-side)
    tryCatch({
        result <- tyla::execute_code(code, id = id)

        list(
            id = result$id,
            status = result$status,
            output = result$output,
            error = result$error,
            duration = result$duration
        )
    }, error = function(e) {
        res$status <- 500
        list(
            id = id,
            status = "error",
            error = conditionMessage(e)
        )
    })
}

#* Get execution result by ID
#* @get /result/<id>
#* @param id:character The execution ID
#* @serializer json
function(id, res) {
    result <- tyla::get_result(id)

    if (is.null(result)) {
        res$status <- 404
        return(list(
            error = "Execution not found",
            id = id
        ))
    }

    list(
        id = result$id,
        status = result$status,
        output = result$output,
        error = result$error,
        duration = result$duration
    )
}

#* Confirm or reject pending execution
#* @post /confirm/<id>
#* @param id:character The execution ID
#* @param approved:logical Whether the execution is approved
#* @serializer json
function(id, req, res, approved = FALSE) {
    result <- tyla::get_result(id)

    if (is.null(result)) {
        res$status <- 404
        return(list(
            error = "Execution not found",
            id = id
        ))
    }

    if (result$status != "pending") {
        res$status <- 400
        return(list(
            error = "Execution is not pending confirmation",
            id = id,
            status = result$status
        ))
    }

    if (approved) {
        # Execute the code
        result <- tyla::execute_code(result$code, id = id)
        list(
            id = result$id,
            status = result$status,
            output = result$output,
            error = result$error,
            duration = result$duration
        )
    } else {
        # Mark as rejected
        list(
            id = id,
            status = "rejected"
        )
    }
}

#* Health check endpoint
#* @get /health
#* @serializer json
function() {
    list(
        status = "ok",
        timestamp = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z")
    )
}

#* API info endpoint
#* @get /
#* @serializer json
function() {
    list(
        name = "Tyla R Bridge API",
        version = as.character(packageVersion("tyla")),
        endpoints = list(
            "GET /status" = "Get server status",
            "POST /execute" = "Execute R code",
            "GET /result/:id" = "Get execution result",
            "POST /confirm/:id" = "Confirm pending execution",
            "GET /health" = "Health check"
        )
    )
}
