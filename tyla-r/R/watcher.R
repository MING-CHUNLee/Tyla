#' File-based Command Watcher
#'
#' Watches for command files written by the Tyla CLI and executes them
#' in the RStudio console using rstudioapi.
#'
#' @name watcher
NULL

# Get the tyla commands directory
get_tyla_dir <- function() {
    dir <- file.path(Sys.getenv("HOME"), ".tyla", "commands")
    if (!dir.exists(dir)) {
        dir.create(dir, recursive = TRUE)
    }
    dir
}

# File paths
get_pending_file <- function() {
    file.path(get_tyla_dir(), "pending.json")
}

get_result_file <- function() {
    file.path(get_tyla_dir(), "result.json")
}

get_lock_file <- function() {
    file.path(get_tyla_dir(), ".lock")
}

#' Start the Command Listener
#'
#' Starts a background listener that watches for commands from the CLI.
#' When a command file is detected, it executes the code in RStudio console.
#'
#' @param interval Numeric. Polling interval in seconds. Default is 0.5.
#' @param quiet Logical. If TRUE, suppress status messages.
#'
#' @return Invisibly returns TRUE.
#'
#' @examples
#' \dontrun{
#' # Start listening for CLI commands
#' tyla::start_listener()
#'
#' # Now in terminal: tyla  (then /run inside the TUI)
#' }
#'
#' @export
start_listener <- function(interval = 0.5, quiet = FALSE) {
    # Check if we're in RStudio
    if (!requireNamespace("rstudioapi", quietly = TRUE) ||
        !rstudioapi::isAvailable()) {
        stop("This function must be run inside RStudio")
    }

    # Check if already running
    if (isTRUE(.tyla_env$listener_running)) {
        if (!quiet) message("Listener is already running")
        return(invisible(TRUE))
    }

    .tyla_env$listener_running <- TRUE
    .tyla_env$listener_interval <- interval

    if (!quiet) {
        message("Tyla listener started")
        message("Watching: ", get_tyla_dir())
        message("Use tyla::stop_listener() to stop")
    }

    # Create lock file to signal CLI that listener is active
    writeLines(as.character(Sys.getpid()), get_lock_file())

    # Start the watcher loop
    watch_for_commands(interval)

    invisible(TRUE)
}

#' Stop the Command Listener
#'
#' Stops the background command listener.
#'
#' @param quiet Logical. If TRUE, suppress messages.
#'
#' @return Invisibly returns TRUE.
#'
#' @export
stop_listener <- function(quiet = FALSE) {
    .tyla_env$listener_running <- FALSE

    # Remove lock file
    lock_file <- get_lock_file()
    if (file.exists(lock_file)) {
        file.remove(lock_file)
    }

    if (!quiet) {
        message("Tyla listener stopped")
    }

    invisible(TRUE)
}

#' Check if Listener is Running
#'
#' @return Logical indicating if the listener is active.
#'
#' @export
is_listener_running <- function() {
    isTRUE(.tyla_env$listener_running)
}

# Internal: Watch for command files
watch_for_commands <- function(interval) {
    if (!isTRUE(.tyla_env$listener_running)) {
        return(invisible(NULL))
    }

    pending_file <- get_pending_file()

    # Check for pending command
    if (file.exists(pending_file)) {
        tryCatch({
            process_command(pending_file)
        }, error = function(e) {
            write_error_result(paste("Error processing command:", e$message))
        })
    }

    # Schedule next check using later package
    later::later(
        function() watch_for_commands(interval),
        delay = interval
    )
}

# Internal: Process a command file
process_command <- function(pending_file) {
    # Read the command
    content <- readLines(pending_file, warn = FALSE)
    content <- paste(content, collapse = "\n")

    # Remove the pending file immediately
    file.remove(pending_file)

    # Parse JSON
    cmd <- jsonlite::fromJSON(content)

    # Determine what to execute based on action
    action <- cmd$action

    if (!is.null(action)) {
        if (action == "run_current") {
            execute_current_file(cmd)
        } else if (action == "get_current_file") {
            get_current_file_handler(cmd)
        } else if (action == "run_code") {
            execute_code_in_console(cmd$code, cmd$id)
        } else if (action == "run_file") {
            execute_file_in_console(cmd$file, cmd$id)
        } else if (action == "render_rmd") {
            render_rmd_file(cmd$file, cmd$id)
        } else if (action == "install_packages") {
            install_packages_handler(cmd)
        } else {
            write_error_result(paste("Unknown action:", action))
        }
    } else if (!is.null(cmd$code)) {
        execute_code_in_console(cmd$code, cmd$id)
    } else if (!is.null(cmd$file)) {
        execute_file_in_console(cmd$file, cmd$id)
    } else {
        write_error_result("Unknown command format")
    }
}

# Internal: Return the currently active file path in RStudio (or empty string)
get_current_file_handler <- function(cmd) {
    # Guard: this listener can run outside RStudio
    if (!rstudioapi::isAvailable()) {
        write_current_file_result(cmd$id, "")
        return(invisible(NULL))
    }

    context <- rstudioapi::getSourceEditorContext()
    if (is.null(context) || is.null(context$path) || context$path == "") {
        write_current_file_result(cmd$id, "")
        return(invisible(NULL))
    }

    write_current_file_result(cmd$id, context$path)
}

# Internal: Write get_current_file success result
write_current_file_result <- function(id, file_path) {
    result <- list(
        id = id,
        status = "completed",
        filePath = file_path,
        timestamp = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z")
    )

    jsonlite::write_json(result, get_result_file(), auto_unbox = TRUE, pretty = TRUE)
}

# Internal: Execute the currently active file in RStudio
execute_current_file <- function(cmd) {
    # Get the active document
    context <- rstudioapi::getSourceEditorContext()

    if (is.null(context) || is.null(context$path) || context$path == "") {
        write_error_result("No file is currently open in RStudio editor", id = cmd$id)
        return(invisible(NULL))
    }

    file_path <- context$path

    # Check if it's an R or Rmd file
    if (!grepl("\\.[Rr](md)?$", file_path)) {
        write_error_result(paste("Current file is not an R or Rmd file:", basename(file_path)), id = cmd$id)
        return(invisible(NULL))
    }

    # If it's an Rmd file, render it instead
    if (grepl("\\.[Rr]md$", file_path)) {
        render_rmd_file(file_path, cmd$id)
        return(invisible(NULL))
    }

    # Save the file first if it has unsaved changes
    if (isTRUE(context$modified)) {
        rstudioapi::documentSave(context$id)
    }

    # Execute the file
    execute_file_in_console(file_path, cmd$id)
}

# Internal: Execute a file in the RStudio console
execute_file_in_console <- function(file_path, id) {
    start_time <- Sys.time()

    # Build the source command
    source_cmd <- sprintf('source("%s", echo = TRUE)', normalizePath(file_path, winslash = "/"))

    tryCatch({
        # Capture output
        output <- capture.output({
            result <- rstudioapi::sendToConsole(source_cmd, execute = TRUE, echo = FALSE)
        })

        end_time <- Sys.time()
        duration <- as.numeric(difftime(end_time, start_time, units = "secs")) * 1000

        write_success_result(
            id = id,
            output = paste(output, collapse = "\n"),
            file = file_path,
            duration = duration
        )
    }, error = function(e) {
        write_error_result(e$message, id = id)
    })
}

# Internal: Execute code in the RStudio console
execute_code_in_console <- function(code, id) {
    start_time <- Sys.time()

    tryCatch({
        # Capture the output of the code execution
        output <- capture.output({
            result <- eval(parse(text = code), envir = .GlobalEnv)
            # If result is not NULL, print it
            if (!is.null(result)) {
                print(result)
            }
        })
        
        # Also send to console for visibility
        rstudioapi::sendToConsole(code, execute = FALSE, echo = TRUE)

        end_time <- Sys.time()
        duration <- as.numeric(difftime(end_time, start_time, units = "secs")) * 1000

        write_success_result(
            id = id,
            output = paste(output, collapse = "\n"),
            duration = duration
        )
    }, error = function(e) {
        write_error_result(e$message, id = id)
    })
}

# Internal: Write success result
write_success_result <- function(id, output, file = NULL, duration = NULL) {
    result <- list(
        id = id,
        status = "completed",
        output = output,
        file = file,
        duration = duration,
        timestamp = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z")
    )

    jsonlite::write_json(result, get_result_file(), auto_unbox = TRUE, pretty = TRUE)
}

# Internal: Render an Rmd file
render_rmd_file <- function(file_path, id) {
    start_time <- Sys.time()

    # Check if rmarkdown is available
    if (!requireNamespace("rmarkdown", quietly = TRUE)) {
        write_error_result("rmarkdown package is not installed. Run: install.packages('rmarkdown')", id = id)
        return(invisible(NULL))
    }

    # Build the render command
    render_cmd <- sprintf('rmarkdown::render("%s")', normalizePath(file_path, winslash = "/"))

    tryCatch({
        # Send render command to console
        rstudioapi::sendToConsole(render_cmd, execute = TRUE, echo = TRUE)

        end_time <- Sys.time()
        duration <- as.numeric(difftime(end_time, start_time, units = "secs")) * 1000

        # Determine output file path
        output_file <- sub("\\.[Rr]md$", ".html", file_path)

        write_success_result(
            id = id,
            output = paste("Render command sent to RStudio Console.\nFile:", basename(file_path), "\nCheck RStudio Console for progress and output."),
            file = file_path,
            duration = duration
        )
    }, error = function(e) {
        write_error_result(e$message, id = id)
    })
}

# Internal: Write error result
write_error_result <- function(error_message, id = NULL) {
    result <- list(
        id = id,
        status = "error",
        error = error_message,
        timestamp = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z")
    )

    jsonlite::write_json(result, get_result_file(), auto_unbox = TRUE, pretty = TRUE)
}

# Internal: Install R packages
install_packages_handler <- function(cmd) {
    start_time <- Sys.time()
    
    result <- list(
        id = cmd$id,
        status = "installing",
        installed = character(0),
        failed = character(0),
        output = "",
        error = NULL
    )
    
    tryCatch({
        packages <- cmd$packages
        repos <- if (!is.null(cmd$repos)) cmd$repos else "https://cran.rstudio.com"
        dependencies <- if (!is.null(cmd$dependencies)) cmd$dependencies else TRUE
        source <- if (!is.null(cmd$source)) cmd$source else "cran"
        
        # Capture output
        output <- capture.output({
            for (pkg in packages) {
                tryCatch({
                    if (source == "cran") {
                        install.packages(pkg, repos = repos, dependencies = dependencies)
                    } else if (source == "github") {
                        # Install remotes if not available
                        if (!requireNamespace("remotes", quietly = TRUE)) {
                            install.packages("remotes", repos = repos)
                        }
                        remotes::install_github(pkg, dependencies = dependencies)
                    } else if (source == "bioconductor") {
                        # Install BiocManager if not available
                        if (!requireNamespace("BiocManager", quietly = TRUE)) {
                            install.packages("BiocManager", repos = repos)
                        }
                        BiocManager::install(pkg, dependencies = dependencies)
                    } else {
                        stop("Unsupported source: ", source)
                    }
                    
                    result$installed <- c(result$installed, pkg)
                    cat("Successfully installed:", pkg, "\n")
                }, error = function(e) {
                    result$failed <<- c(result$failed, pkg)
                    cat("Error installing", pkg, ":", e$message, "\n")
                })
            }
        })
        
        result$output <- paste(output, collapse = "\n")
        
        # Determine final status
        if (length(result$failed) == 0) {
            result$status <- "completed"
        } else if (length(result$installed) > 0) {
            result$status <- "partial"
        } else {
            result$status <- "error"
        }
        
    }, error = function(e) {
        result$status <- "error"
        result$error <- e$message
    })
    
    end_time <- Sys.time()
    result$duration <- as.numeric(difftime(end_time, start_time, units = "secs")) * 1000
    
    # Write result
    jsonlite::write_json(result, get_result_file(), auto_unbox = TRUE, pretty = TRUE)
}
