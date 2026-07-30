#' Code Execution Engine
#'
#' Functions for executing R code and managing execution results.
#'
#' @name executor
NULL

# Environment for storing execution results
.execution_env <- new.env(parent = emptyenv())
.execution_env$results <- list()
.execution_env$pending <- list()

#' Execute R Code
#'
#' Executes R code in the current session and captures output.
#'
#' @param code Character. The R code to execute.
#' @param id Character. Optional execution ID. If NULL, one will be generated.
#' @param capture_output Logical. If TRUE, capture stdout/stderr.
#' @param envir Environment. The environment in which to evaluate the code.
#'
#' @return A list with execution results.
#'
#' @export
execute_code <- function(code, id = NULL, capture_output = TRUE, envir = globalenv()) {
    # Generate ID if not provided
    if (is.null(id)) {
        id <- uuid::UUIDgenerate()
    }

    # Initialize result structure
    result <- list(
        id = id,
        status = "running",
        code = code,
        output = NULL,
        error = NULL,
        value = NULL,
        start_time = Sys.time(),
        end_time = NULL,
        duration = NULL
    )

    # Store as pending
    .execution_env$pending[[id]] <- result

    tryCatch({
        # Capture output
        if (capture_output) {
            output_con <- textConnection("output_text", "w", local = TRUE)
            sink(output_con, type = "output")
            on.exit({
                sink(type = "output")
                close(output_con)
            }, add = TRUE)
        }

        # Parse and evaluate the code
        parsed <- parse(text = code)
        value <- NULL

        for (expr in parsed) {
            value <- eval(expr, envir = envir)
        }

        # Get captured output
        if (capture_output) {
            sink(type = "output")
            close(output_con)
            on.exit(NULL)  # Remove the exit handler
            result$output <- paste(output_text, collapse = "\n")
        }

        # If value is printable, add it to output
        if (!is.null(value) && !inherits(value, "function")) {
            value_output <- capture.output(print(value))
            if (is.null(result$output) || result$output == "") {
                result$output <- paste(value_output, collapse = "\n")
            } else {
                result$output <- paste(result$output, paste(value_output, collapse = "\n"), sep = "\n")
            }
        }

        result$status <- "completed"
        result$value <- value

    }, error = function(e) {
        result$status <<- "error"
        result$error <<- conditionMessage(e)
    }, warning = function(w) {
        # Continue on warnings, but capture them
        if (is.null(result$output)) {
            result$output <<- paste("Warning:", conditionMessage(w))
        } else {
            result$output <<- paste(result$output, paste("Warning:", conditionMessage(w)), sep = "\n")
        }
        invokeRestart("muffleWarning")
    })

    # Finalize result
    result$end_time <- Sys.time()
    result$duration <- as.numeric(difftime(result$end_time, result$start_time, units = "secs")) * 1000

    # Move from pending to results
    .execution_env$pending[[id]] <- NULL
    .execution_env$results[[id]] <- result

    # Clean up old results (keep last 100)
    if (length(.execution_env$results) > 100) {
        oldest_ids <- names(sort(sapply(.execution_env$results, function(r) r$end_time)))[1:50]
        for (old_id in oldest_ids) {
            .execution_env$results[[old_id]] <- NULL
        }
    }

    result
}

#' Get Execution Result
#'
#' Retrieves the result of a previous execution by ID.
#'
#' @param id Character. The execution ID.
#'
#' @return A list with execution results, or NULL if not found.
#'
#' @export
get_result <- function(id) {
    # Check pending first
    if (!is.null(.execution_env$pending[[id]])) {
        return(.execution_env$pending[[id]])
    }

    # Check completed results
    if (!is.null(.execution_env$results[[id]])) {
        return(.execution_env$results[[id]])
    }

    NULL
}

#' Clear Execution Results
#'
#' Clears all stored execution results.
#'
#' @return Invisibly returns the number of results cleared.
clear_results <- function() {
    count <- length(.execution_env$results) + length(.execution_env$pending)
    .execution_env$results <- list()
    .execution_env$pending <- list()
    invisible(count)
}

#' Execute Code in RStudio Console
#'
#' If running in RStudio, executes code in the console.
#' Otherwise, executes in the current session.
#'
#' @param code Character. The R code to execute.
#' @param id Character. Optional execution ID.
#'
#' @return A list with execution results.
execute_in_console <- function(code, id = NULL) {
    if (is.null(id)) {
        id <- uuid::UUIDgenerate()
    }

    # Check if we're in RStudio
    if (requireNamespace("rstudioapi", quietly = TRUE) &&
        rstudioapi::isAvailable()) {

        # Use rstudioapi to send to console
        tryCatch({
            rstudioapi::sendToConsole(code, execute = TRUE)

            # Since sendToConsole doesn't return output,
            # we still execute locally to capture it
            result <- execute_code(code, id = id)
            result$executed_in <- "rstudio_console"
            result
        }, error = function(e) {
            # Fallback to local execution
            result <- execute_code(code, id = id)
            result$executed_in <- "local"
            result
        })
    } else {
        # Execute locally
        result <- execute_code(code, id = id)
        result$executed_in <- "local"
        result
    }
}
