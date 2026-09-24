// A Go test program: prints each file it is given, read concurrently from goroutines, in order.
// Built by test/support/programs.ts.
package main

import (
	"os"
	"sync"
)

func main() {
	files := os.Args[1:]
	contents := make([][]byte, len(files))
	var wg sync.WaitGroup
	for i, f := range files {
		wg.Add(1)
		go func(i int, f string) {
			defer wg.Done()
			contents[i], _ = os.ReadFile(f)
		}(i, f)
	}
	wg.Wait()
	for _, c := range contents {
		os.Stdout.Write(c)
	}
}
