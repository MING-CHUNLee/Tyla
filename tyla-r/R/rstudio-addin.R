#' RStudio Addins
#'
#' RStudio Addin functions for the Tyla package.
#'
#' @name addins
NULL

#' Start Tyla Server Addin
#'
#' RStudio Addin to start the Tyla API server.
#' This function is called when the user clicks the "Start Tyla Server" addin.
#'
#' @return Invisibly returns NULL.
start_server_addin <- function() {
    # Check if server is already running
    status <- server_status()

    if (status$running) {
        if (requireNamespace("rstudioapi", quietly = TRUE)) {
            rstudioapi::showDialog(
                title = "Tyla Server",
                message = paste0(
                    "Server is already running on port ", status$port, "\n\n",
                    "Uptime: ", round(status$uptime, 1), " seconds"
                )
            )
        } else {
            message("Tyla server is already running on port ", status$port)
        }
        return(invisible(NULL))
    }

    # Start the server
    tryCatch({
        start_server(background = TRUE, quiet = FALSE)

        if (requireNamespace("rstudioapi", quietly = TRUE)) {
            rstudioapi::showDialog(
                title = "Tyla Server Started",
                message = paste0(
                    "Tyla API server is now running!\n\n",
                    "URL: http://localhost:", .tyla_env$port, "\n\n",
                    "You can now use 'tyla' from the terminal."
                )
            )
        }
    }, error = function(e) {
        if (requireNamespace("rstudioapi", quietly = TRUE)) {
            rstudioapi::showDialog(
                title = "Error",
                message = paste0("Failed to start server:\n\n", e$message)
            )
        } else {
            message("Failed to start server: ", e$message)
        }
    })

    invisible(NULL)
}

#' Stop Tyla Server Addin
#'
#' RStudio Addin to stop the Tyla API server.
#'
#' @return Invisibly returns NULL.
stop_server_addin <- function() {
    status <- server_status()

    if (!status$running) {
        if (requireNamespace("rstudioapi", quietly = TRUE)) {
            rstudioapi::showDialog(
                title = "Tyla Server",
                message = "No server is currently running."
            )
        } else {
            message("No Tyla server is running")
        }
        return(invisible(NULL))
    }

    stop_server(quiet = FALSE)

    if (requireNamespace("rstudioapi", quietly = TRUE)) {
        rstudioapi::showDialog(
            title = "Tyla Server Stopped",
            message = "The Tyla API server has been stopped."
        )
    }

    invisible(NULL)
}

#' Show Tyla Server Status Addin
#'
#' RStudio Addin to show the current server status.
#'
#' @return Invisibly returns NULL.
server_status_addin <- function() {
    status <- server_status()

    if (requireNamespace("rstudioapi", quietly = TRUE)) {
        if (status$running) {
            rstudioapi::showDialog(
                title = "Tyla Server Status",
                message = paste0(
                    "Status: Running\n",
                    "Port: ", status$port, "\n",
                    "Uptime: ", round(status$uptime, 1), " seconds\n",
                    "R Version: ", status$r_version, "\n",
                    "Session ID: ", status$session_id
                )
            )
        } else {
            rstudioapi::showDialog(
                title = "Tyla Server Status",
                message = "Status: Not Running\n\nClick 'Start Tyla Server' to start."
            )
        }
    } else {
        print(status)
    }

    invisible(NULL)
}
