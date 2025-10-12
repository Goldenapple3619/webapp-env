# RoadMap

## Features Addition:
    - Desktop Environnement:
        - ✅ Basic Taskbar
        - Application menu
        - ✅ Desktop mouse drag thingy
        - Desktop app shortcut
        - Disconnect menu

        - Widgets
            - Connectivity
            - Apps gateway status
            - Sessions debug

    - Apps:
        - Explorer
            - Add create folder/file
            - Add drag folder/file
            - Add remove folder/file
            - Add open folder/file
            - Add dowload folder (as zip)/file
            - Add upload folder (as zip)/file

        - Terminal emulator
            - Basic shell
            - Open gui applications ?
            - Ansi codes
            - Configuration file

        - Music
            - Create playlist

## Fixes:
    - App mouse draging ugly selection on HTML Doms
    - Responsiveness of elements
    - JavaScript page redirect not working on mobile (chrome web driver different standard on phone ??)

## Architectural changes:
    - Lazy loading of application UIs when not directly loaded
    - Latency evaluation from the API to order websockets

## Refactor:
    - Remake the CSS to work on a "theme" system
    - Unify CSS make it look good
    - App fullscreen mode on desktop different from standalone app mode 
