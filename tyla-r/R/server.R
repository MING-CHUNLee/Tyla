#' Tyla Server Management
#'
#' Functions to start and stop the Tyla listener.
#' The listener watches for commands from the CLI and executes them in RStudio.
#'
#' @name server
NULL

# Package-level environment for storing state
.tyla_env <- new.env(parent = emptyenv())
.tyla_env$listener_running <- FALSE
.tyla_env$listener_interval <- 0.5
.tyla_env$start_time <- NULL

#' Start Tyla
#'
#' Starts the Tyla listener that watches for CLI commands.
#' This is the main entry point - just run tyla::start() in RStudio.
#'
#' @param interval Numeric. Polling interval in seconds. Default is 0.5.
#' @param quiet Logical. If TRUE, suppress startup messages.
#'
#' @return Invisibly returns TRUE.
#'
#' @examples
#' \dontrun{
#' # Start Tyla in RStudio
#' tyla::start()
#'
#' # Now in terminal:
#' # tyla            <- opens the interactive TUI (/run runs the current file)
#' # tyla agent ...  <- agentic edit workflow
#'
#' # Stop when done
#' tyla::stop()
#' }
#'
#' @export
start <- function(interval = 0.5, quiet = FALSE) {
    start_listener(interval = interval, quiet = quiet)
}

#' Stop Tyla
#'
#' Stops the Tyla listener.
#'
#' @param quiet Logical. If TRUE, suppress messages.
#'
#' @return Invisibly returns TRUE.
#'
#' @export
stop <- function(quiet = FALSE) {
    stop_listener(quiet = quiet)
}

#' Get Tyla Status
#'
#' Returns the current status of the Tyla listener.
#'
#' @return A list with status information.
#'
#' @export
status <- function() {
    running <- isTRUE(.tyla_env$listener_running)

    status <- list(
        running = running,
        start_time = if (running) .tyla_env$start_time else NA,
        uptime = if (running && !is.null(.tyla_env$start_time))
            as.numeric(difftime(Sys.time(), .tyla_env$start_time, units = "secs")) else NA,
        r_version = paste(R.version$major, R.version$minor, sep = "."),
        session_id = Sys.getpid(),
        commands_dir = get_tyla_dir()
    )

    class(status) <- c("tyla_status", "list")
    status
}

#' Print method for tyla_status
#'
#' @param x A tyla_status object
#' @param ... Additional arguments (ignored)
#'
#' @export
print.tyla_status <- function(x, ...) {
    cat("Tyla Status\n")
    cat("-----------\n")
    cat("Listener:   ", if (x$running) "Running" else "Stopped", "\n")
    if (x$running) {
        cat("Uptime:     ", round(x$uptime, 1), " seconds\n")
    }
    cat("R Version:  ", x$r_version, "\n")
    cat("Session ID: ", x$session_id, "\n")
    cat("Commands:   ", x$commands_dir, "\n")
    invisible(x)
}

# Keep old names for backward compatibility
#' @rdname start
#' @export
start_server <- start

#' @rdname stop
#' @export
stop_server <- stop

#' @rdname status
#' @export
server_status <- status
